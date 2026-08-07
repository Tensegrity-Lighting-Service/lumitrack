"""Local WebSocket sidecar exposing core/ to the Tauri/React frontend.

Backend-autoritaire (CONCEPTION.md §12.11/§13.1.7): this process owns the
Transport clock and all interpolation. The frontend never recomputes
positions on its own — it only ever displays what this server pushes, at
`TICK_HZ`. Project-mutating commands get echoed back as a full `project`
snapshot to every connected client rather than diffed, since the model is
small (JSON, no media inline) and this removes an entire class of
front/back drift bugs.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import time
import uuid
from typing import Optional

import websockets

from .core.project import (
    Project, Point, Cue, Activation, import_stancz, save_bundle, load_bundle, list_archive,
)
from .core.timeline import (
    Timeline, OutputTransform, resolve_block_context,
    required_fade_ms_per_point, resolve_trajectories, MIN_AUTO_DURATION_MS,
)
from .core.engine import Transport, PsnBroadcaster
from .core.timecode import ArtNetTimecodeReceiver

logger = logging.getLogger("lumitrack.sidecar")

TICK_HZ = 30
AUTOSAVE_INTERVAL_S = 2.0

# Undo/redo (§13.1.10 "non négociable", DIRECTIVES.md Mission 3). Historique
# côté sidecar (backend-autoritaire, §12.11) : le frontend ne garde jamais
# lui-même d'états passés, il envoie juste `undo`/`redo`.
#
# Une rafale d'éditions rapprochées (un drag d'acteur/de zone envoie un
# `set_activation`/`update_stage_map` toutes les ~33 ms tout le temps du
# geste, la saisie inspecteur peut committer plusieurs fois de suite) doit
# rester UN SEUL pas d'annulation, pas un par message réseau — sinon
# annuler un simple drag demanderait des dizaines de Ctrl+Z. Un nouveau
# point de reprise n'est ouvert que si la dernière édition remonte à plus de
# UNDO_COALESCE_S : tant que les messages s'enchaînent plus vite que ça
# (un geste continu), ils fusionnent dans l'entrée déjà ouverte.
UNDO_COALESCE_S = 0.7
UNDO_MAX_DEPTH = 200

# Types de commande qui modifient le contenu du projet et doivent donc être
# annulables. Volontairement exclus : transport (lecture, pas édition),
# psn_start/stop et update_psn_config (réglages réseau/sortie, pas contenu
# créatif), resolve_block_context/list_ifaces/psn_preview (lecture seule).
MUTATING_COMMANDS = {
    "set_audio", "update_point", "update_stage_map", "set_backstage_zones",
    "add_point", "add_cue", "update_cue", "delete_cue", "set_activation",
    "set_activations", "set_fixture_mount_presets",
    "apply_group_transform", "delete_point", "reorder_points", "set_roster_groups",
    # Contrairement à update_psn_config (réseau/sortie) : la vitesse de
    # référence recalcule la durée de vrais blocs (contenu créatif).
    "update_project_settings",
    # Réglage projet persisté (timecode In) : l'écho projet doit repartir
    # pour que la case du menu reflète l'état réel.
    "set_timecode_chase",
}
# Remplacement intégral du projet : l'historique d'un AUTRE projet n'a plus
# de sens une fois chargé un nouveau, donc on le vide plutôt que de le
# rendre annulable (annuler un "Nouveau projet" ramènerait dans l'ancien
# projet sans qu'on l'ait "ouvert" — confusion garantie avec Fichier/Ouvrir).
RESET_UNDO_COMMANDS = {"new_project", "import_stancz", "load_bundle", "load_rescue"}


def rescue_path() -> str:
    """Fichier de SECOURS anti-crash : %APPDATA%/Lumitrack/rescue.json
    (Windows), ~/.config/Lumitrack sinon. JSON simple (pas un bundle : les
    médias restent référencés en chemins absolus, pas copiés).

    Nouveau contrat (demande 2026-08-07) : ce fichier n'est PLUS une
    reprise de session automatique — il est écrit en continu pendant
    l'usage, EFFACÉ à toute sortie propre (message `clean_exit`, que
    l'utilisateur ait sauvegardé ou non), et sa présence au démarrage
    signifie donc un CRASH : le frontend propose alors de récupérer la
    session (`rescue_available` → `load_rescue`/`discard_rescue`)."""
    base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), ".config")
    directory = os.path.join(base, "Lumitrack")
    os.makedirs(directory, exist_ok=True)
    return os.path.join(directory, "rescue.json")


def _demo_project() -> Project:
    """A tiny built-in project so the frontend has something to render
    before any file is imported/opened."""
    project = Project(name="Demo", stage_width_cm=6000, stage_height_cm=4000)
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    gltf = os.path.join(repo_root, "Sources", "Belfius_Hockey_Arena.glb")
    if os.path.isfile(gltf):
        project.terrain_gltf_path = gltf

    project.points = [
        Point(id="p1", name="Astera 1", number=1, color="#4F6DF5"),
        Point(id="p2", name="Astera 2", number=2, color="#F5734F"),
        Point(id="p3", name="Astera 3", number=3, color="#4FF58C"),
    ]
    cue_a = Cue(id=str(uuid.uuid4()), name="Entree", start_ms=0, duration_ms=4000, color="#4F6DF5")
    cue_a.activations = {
        "p1": Activation(target_x_cm=1000, target_y_cm=1000, fade_ms=4000,
                          travel_orientation_mode="fixed", travel_fixed_yaw_deg=0),
        "p2": Activation(target_x_cm=3000, target_y_cm=1000, fade_ms=4000,
                          travel_orientation_mode="fixed", travel_fixed_yaw_deg=90),
        "p3": Activation(target_x_cm=5000, target_y_cm=1000, fade_ms=4000,
                          travel_orientation_mode="fixed", travel_fixed_yaw_deg=180),
    }
    cue_b = Cue(id=str(uuid.uuid4()), name="Rassemblement", start_ms=4000, duration_ms=4000, color="#F5734F")
    cue_b.activations = {
        "p1": Activation(target_x_cm=2500, target_y_cm=2500, fade_ms=3000,
                          travel_orientation_mode="fixed", travel_fixed_yaw_deg=45),
        "p2": Activation(target_x_cm=3000, target_y_cm=2500, fade_ms=3000,
                          travel_orientation_mode="fixed", travel_fixed_yaw_deg=45),
        "p3": Activation(target_x_cm=3500, target_y_cm=2500, fade_ms=3000,
                          travel_orientation_mode="fixed", travel_fixed_yaw_deg=45),
    }
    # Overlaps cue_b on purpose: demonstrates that overlapping cues need
    # their own timeline lane rather than sharing one row (§12.1).
    cue_c = Cue(id=str(uuid.uuid4()), name="Contre-jour", start_ms=5000, duration_ms=2000, color="#B06FE0")
    cue_c.activations = {
        # Pure rotation, no x/y move: needs orientation_overridden=True so
        # touches_orientation() still governs the yaw axis (see project.py).
        "p2": Activation(fade_ms=1500, orientation_overridden=True,
                          travel_orientation_mode="fixed", travel_fixed_yaw_deg=225),
    }
    project.cues = [cue_a, cue_b, cue_c]
    project.transform_origin_x_cm = project.stage_width_cm / 2
    project.transform_origin_y_cm = project.stage_height_cm / 2
    project.ensure_backstage()
    return project


class Session:
    """The one open project + transport + PSN broadcaster for this sidecar
    process, and the set of connected frontend sockets to push to."""

    def __init__(self):
        # Plus de reprise de session automatique (2026-08-07) : on démarre
        # sur le projet de démo, et la présence d'un fichier de secours
        # (= la sortie précédente n'était PAS propre) est signalée au
        # frontend qui PROPOSE la récupération.
        path = rescue_path()
        legacy = os.path.join(os.path.dirname(path), "autosave.json")
        if not os.path.isfile(path) and os.path.isfile(legacy):
            # Migration : l'ancienne autosave devient un fichier de secours.
            os.replace(legacy, path)
        self.rescue_available = os.path.isfile(path)
        if self.rescue_available:
            logger.info("Fichier de secours présent (%s) — récupération proposée", path)
        # Sortie propre demandée : gèle l'écriture du fichier de secours.
        self.exiting = False
        self.project = _demo_project()
        # Même assainissement anti-superposition qu'au chargement d'un
        # projet (set_project) — l'autosave restauré peut précéder
        # l'invariant (tranche H, 2026-08-07).
        _sanitize_all_lanes(self.project)
        self.dirty = False
        self.timeline = Timeline(self.project)
        self.transport = Transport()
        self.transport.set_duration(self.timeline.duration_ms)
        self.broadcaster = PsnBroadcaster(self.transport)
        self._apply_psn_config()
        # "Timecode In" Art-Net (2026-08-06) : le récepteur pousse chaque
        # paquet dans le Transport (thread-safe), qui ne le suit que si
        # external_sync est armé — voir _apply_timecode_chase.
        self.timecode_input = ArtNetTimecodeReceiver(self._on_external_timecode)
        self._apply_timecode_chase()
        self.clients: set = set()
        self._undo_stack: list = []
        self._redo_stack: list = []
        # None, not 0.0: a real time.monotonic() reading could legitimately
        # be small (platform-dependent epoch), which would collide with a
        # 0.0 sentinel and wrongly coalesce the very first edit away.
        self._last_edit_wall: Optional[float] = None

    def _apply_psn_config(self):
        self.broadcaster.transform = OutputTransform.from_project(self.project)
        self.broadcaster.set_project(self.project, self.timeline)
        self.broadcaster.configure(
            mcast_ip=self.project.psn_mcast_ip,
            port=self.project.psn_port,
            system_name=self.project.psn_system_name,
            iface_ip=getattr(self.project, "psn_iface_ip", "0.0.0.0"),
            rate_hz=int(getattr(self.project, "psn_rate_hz", 30)),
        )

    def set_project(self, project: Project):
        self.project = project
        # Assainissement anti-superposition (tranche H, 2026-08-07) : les
        # sauvegardes d'AVANT l'invariant peuvent contenir des blocs
        # superposés — relogés chronologiquement AVANT de construire la
        # timeline.
        _sanitize_all_lanes(project)
        self.dirty = True
        self.timeline = Timeline(project)
        self.transport.set_duration(self.timeline.duration_ms)
        self._apply_psn_config()
        self._apply_timecode_chase()

    def _on_external_timecode(self, tc_ms: float, fps: float):
        """Depuis le thread du récepteur : le décalage projet (déjà présent
        pour l'audio) recale le TC de régie sur le zéro de la timeline."""
        self.transport.apply_external(tc_ms - self.project.timecode_offset_ms, fps)

    def _apply_timecode_chase(self):
        """Synchronise récepteur + transport avec le réglage projet — appelé
        à l'init, à chaque changement de projet et par set_timecode_chase."""
        if self.project.timecode_chase_enabled:
            # Changement de carte réseau à chaud : re-bind sur la nouvelle.
            if (self.timecode_input.running
                    and self.timecode_input.bind_ip != self.project.timecode_iface_ip):
                self.timecode_input.stop()
            self.timecode_input.bind_ip = self.project.timecode_iface_ip
            self.transport.external_sync = True
            self.timecode_input.start()
        else:
            was_chasing = self.transport.external_sync
            self.timecode_input.stop()
            self.transport.external_sync = False
            if was_chasing:
                # Revenir à l'horloge interne sans embarquer l'état playing
                # posé par apply_external : figé là où le TC s'est arrêté.
                self.transport.pause()

    # ---- undo/redo ----

    def checkpoint_undo(self):
        """Call BEFORE applying a mutating command. Opens a new undo entry
        unless the previous edit was less than UNDO_COALESCE_S ago — see
        module docstring for why (gesture coalescing)."""
        now = time.monotonic()
        if self._last_edit_wall is None or now - self._last_edit_wall > UNDO_COALESCE_S:
            self._undo_stack.append(self.project.to_dict())
            if len(self._undo_stack) > UNDO_MAX_DEPTH:
                del self._undo_stack[0]
            self._redo_stack.clear()
        self._last_edit_wall = now

    def reset_undo_history(self):
        self._undo_stack.clear()
        self._redo_stack.clear()
        self._last_edit_wall = None

    def undo(self) -> bool:
        if not self._undo_stack:
            return False
        current = self.project.to_dict()
        previous = self._undo_stack.pop()
        self._redo_stack.append(current)
        self.set_project(Project.from_dict(previous))
        self._last_edit_wall = None  # next edit always opens a fresh entry
        return True

    def redo(self) -> bool:
        if not self._redo_stack:
            return False
        current = self.project.to_dict()
        nxt = self._redo_stack.pop()
        self._undo_stack.append(current)
        self.set_project(Project.from_dict(nxt))
        self._last_edit_wall = None
        return True

    # ---- outbound snapshots ----

    def project_message(self) -> dict:
        return {"type": "project", "project": self.project.to_dict(),
                "psnRunning": self.broadcaster.running,
                "undoAvailable": bool(self._undo_stack),
                "redoAvailable": bool(self._redo_stack)}

    def tick_message(self) -> dict:
        t_ms = self.transport.now_ms()
        poses = self.timeline.positions_at(t_ms)
        msg = {
            "type": "tick",
            "tMs": t_ms,
            "playing": self.transport.playing,
            "durationMs": self.timeline.duration_ms,
            "positions": {
                pid: [pose.x_cm, pose.y_cm, pose.z_cm, pose.yaw_deg]
                for pid, pose in poses.items()
            },
        }
        if self.project.timecode_chase_enabled:
            msg["timecode"] = {
                "receiving": self.transport.external_is_live(),
                "fps": self.timecode_input.last_fps,
                "hmsf": list(self.timecode_input.last_hmsf) if self.timecode_input.last_hmsf else None,
            }
        return msg

    async def broadcast(self, message: dict):
        if not self.clients:
            return
        payload = json.dumps(message)
        stale = []
        for ws in list(self.clients):
            try:
                await ws.send(payload)
            except websockets.ConnectionClosed:
                stale.append(ws)
        for ws in stale:
            self.clients.discard(ws)


async def _tick_loop(session: Session):
    period = 1.0 / TICK_HZ
    while True:
        await session.broadcast(session.tick_message())
        await asyncio.sleep(period)


async def _autosave_loop(session: Session):
    """Fichier de secours continu : écrit rescue.json ~2 s après la
    dernière mutation. En cas de CRASH (kill brutal, aucun handler ne
    tourne sous Windows), tout est déjà sur disque et le prochain
    démarrage proposera la récupération. À la sortie PROPRE, `clean_exit`
    supprime le fichier et gèle cette boucle (session.exiting).
    Écriture ATOMIQUE (tmp + replace) : un kill en plein write ne peut pas
    corrompre le fichier."""
    path = rescue_path()
    while True:
        await asyncio.sleep(AUTOSAVE_INTERVAL_S)
        if session.exiting or not session.dirty:
            continue
        session.dirty = False
        try:
            tmp = path + ".tmp"
            session.project.save(tmp)
            os.replace(tmp, path)
        except Exception:
            session.dirty = True  # on retentera au prochain tour
            logger.exception("Échec de l'écriture du fichier de secours")


def _apply_auto_duration(project: Project, cue: Cue) -> None:
    """Écrit la durée automatique : le fade_ms de CHAQUE activation du bloc
    (ce qui gouverne réellement sa vitesse de déplacement), pas seulement
    `cue.duration_ms` (largeur visuelle du bloc dans la timeline) — sinon
    la boîte change de vitesse affichée mais les acteurs continuent de
    bouger à leur ancien fade_ms (signalé 2026-08-03 : "la boîte a changé
    de vitesse mais les acteurs non"). `cue.duration_ms` suit le plus lent
    à TERMINER (décalage de départ inclus, sinon un acteur décalé pourrait
    finir après la fin du bloc), les autres arrivent avant et attendent
    (maintien déjà existant)."""
    per_point = required_fade_ms_per_point(project, cue)
    finish_times = []
    for point_id, computed_fade_ms in per_point.items():
        act = cue.activations.get(point_id)
        if act is None:
            continue
        if act.fade_overridden:
            # "global vs sélectif" : un acteur personnalisé garde SA valeur —
            # elle compte quand même pour la largeur du bloc, qui doit rester
            # assez large pour lui.
            finish_times.append(act.start_offset_ms + act.fade_ms)
        else:
            act.fade_ms = computed_fade_ms
            finish_times.append(act.start_offset_ms + computed_fade_ms)
    cue.duration_ms = max(finish_times, default=MIN_AUTO_DURATION_MS)
    # Une durée auto qui s'allonge peut faire déborder le bloc sur son
    # voisin de piste — l'invariant "jamais deux blocs superposés" (tranche
    # H, 2026-08-07) est ré-établi ici comme après toute mutation de
    # fenêtre.
    _resolve_lane_overlap(project, cue)


def _cues_overlap(a: Cue, b: Cue) -> bool:
    return (a.start_ms < b.start_ms + b.duration_ms
            and b.start_ms < a.start_ms + a.duration_ms)


def _resolve_lane_overlap(project: Project, cue: Cue) -> None:
    """Invariant "jamais deux blocs superposés sur une même piste" (demande
    Florian 2026-08-07) — filet GARANTI côté moteur, quel que soit le chemin
    (geste libre, +bloc, drag, resize, durée auto, dupliquer, coller...).
    Le frontend clampe déjà pendant le geste pour le confort ; ici, si le
    bloc modifié chevauche un voisin de sa piste, il est relogé sur la
    PREMIÈRE piste où son intervalle est libre (piste existante, sinon une
    nouvelle en dessous). Politique déterministe : c'est le bloc MODIFIÉ
    qui bouge, jamais les autres (pas d'effet domino)."""
    def conflicts(lane: int) -> bool:
        return any(c is not cue and (c.lane or 0) == lane and _cues_overlap(cue, c)
                   for c in project.cues)

    if not conflicts(cue.lane or 0):
        return
    lane = 0
    while conflicts(lane):
        lane += 1
    cue.lane = lane


def _sanitize_all_lanes(project: Project) -> None:
    """Assainissement GLOBAL (chargement d'une sauvegarde d'avant
    l'invariant) : place les blocs un par un dans l'ordre chronologique, en
    ne résolvant chaque bloc que contre les blocs DÉJÀ placés — sinon le
    premier bloc traité se ferait éjecter de sa piste par des blocs pas
    encore relogés (constaté au premier jet du test)."""
    placed: list = []
    for cue in sorted(project.cues, key=lambda c: (c.start_ms, c.id)):
        def conflicts(lane: int) -> bool:
            return any((p.lane or 0) == lane and _cues_overlap(cue, p) for p in placed)
        lane = cue.lane or 0
        if conflicts(lane):
            lane = 0
            while conflicts(lane):
                lane += 1
        cue.lane = lane
        placed.append(cue)


def _sync_activation_orientation_defaults(cue: Cue, act: Activation) -> None:
    """Recopie les défauts d'orientation ACTUELS du bloc sur une activation
    (mission "modes d'orientation", 2026-08-04) — un défaut resté None
    (jamais réglé côté bloc) ne touche pas l'activation sur cette phase."""
    if cue.default_travel_orientation_mode is not None:
        act.travel_orientation_mode = cue.default_travel_orientation_mode
        act.travel_fixed_yaw_deg = cue.default_travel_fixed_yaw_deg or 0.0
        act.travel_focus_point_id = cue.default_travel_focus_point_id
    if cue.default_arrival_orientation_mode is not None:
        act.arrival_orientation_mode = cue.default_arrival_orientation_mode
        act.arrival_fixed_yaw_deg = cue.default_arrival_fixed_yaw_deg or 0.0
        act.arrival_focus_point_id = cue.default_arrival_focus_point_id
    if cue.default_mount_preset_id is not None:
        # "" = défaut explicite "ne rien changer" -> l'activation repasse à
        # None ; sinon l'id du preset (2026-08-05, preset au niveau bloc).
        act.mount_preset_id = cue.default_mount_preset_id or None
    if cue.default_yaw_turn_ms is not None:
        act.yaw_turn_ms = max(0.0, float(cue.default_yaw_turn_ms))


def _apply_cue_orientation_defaults(cue: Cue) -> None:
    """Resynchronise toute activation NON personnalisée du bloc (miroir de
    _apply_auto_duration pour le fade) — déclenché par update_cue dès qu'un
    default* d'orientation change."""
    for act in cue.activations.values():
        if not act.orientation_overridden:
            _sync_activation_orientation_defaults(cue, act)


def _apply_activation_patch(session: Session, cue: Cue, msg: dict):
    """Applique un patch d'activation (les clés camelCase du protocole)
    sur UN point d'un cue — corps commun de set_activation (unitaire) et
    set_activations (groupé, optimisation 2026-08-06). Retourne un dict
    d'erreur ou None ; l'appelant gère auto-duration/rebuild/broadcast
    UNE seule fois pour tout le lot."""
    point_id = msg.get("pointId")
    if session.project.point_by_id(point_id) is None:
        return {"type": "error", "message": f"Unknown point id {point_id!r}"}
    act = cue.activations.get(point_id)
    is_new_activation = act is None
    act = act or Activation()
    if is_new_activation and "fadeMs" not in msg and not cue.auto_duration:
        # "le timing de l'acteur ne suit pas le timing du bloc ... on
        # dirait qu'ils sont par défaut désynchronisés" (Florian,
        # 2026-08-03) : un acteur fraîchement activé (glisser dans la
        # scène, dépôt roster, "+ Activer un point") héritait du
        # fade_ms par défaut du dataclass (1000 ms), sans aucun rapport
        # avec la durée réelle du bloc. Un bloc SANS durée automatique
        # EST par définition le fade par défaut de ses membres — un
        # nouvel acteur suit cette durée dès sa création, pas une
        # constante arbitraire. (Durée automatique active : laissé au
        # recalcul par distance/vitesse ci-dessous, comme d'habitude.)
        act.fade_ms = max(MIN_AUTO_DURATION_MS, cue.duration_ms - act.start_offset_ms)
    orientation_keys = (
        "travelOrientationMode", "travelFixedYawDeg", "travelFocusPointId",
        "arrivalOrientationMode", "arrivalFixedYawDeg", "arrivalFocusPointId",
        "mountPresetId", "yawTurnMs",
    )
    if is_new_activation and not any(k in msg for k in orientation_keys):
        # Préremplissage (DIRECTIVES.md point 5/6, "réglage par défaut"
        # à 2 niveaux) — n'a d'effet que sur une activation TOUTE
        # NEUVE, jamais sur une déjà réglée : d'abord les défauts du
        # BLOC s'ils sont réglés, sinon le repli du Point (trajet
        # seulement — l'arrivée retombe toujours sur "hold").
        if (cue.default_travel_orientation_mode is not None
                or cue.default_arrival_orientation_mode is not None
                or cue.default_mount_preset_id is not None
                or cue.default_yaw_turn_ms is not None):
            _sync_activation_orientation_defaults(cue, act)
        else:
            point = session.project.point_by_id(point_id)
            if point is not None:
                act.travel_orientation_mode = point.default_travel_orientation_mode
    for field_name, json_key in (
        ("target_x_cm", "targetXCm"), ("target_y_cm", "targetYCm"),
        ("target_z_cm", "targetZCm"),
    ):
        if json_key in msg:
            setattr(act, field_name, msg[json_key])
    if "fadeMs" in msg:
        act.fade_ms = float(msg["fadeMs"])
    if "startOffsetMs" in msg:
        # Jamais négatif : un acteur ne peut pas démarrer avant le bloc
        # qui le contient (voir Activation.start_offset_ms).
        act.start_offset_ms = max(0.0, float(msg["startOffsetMs"]))
    if "fadeOverridden" in msg:
        act.fade_overridden = bool(msg["fadeOverridden"])
        # "Revenir au bloc" (bouton inspecteur) envoie fadeOverridden:
        # false seul — en durée automatique, _apply_auto_duration plus
        # bas s'en charge déjà ; sinon (bloc manuel), synchronise cette
        # activation sur la durée actuelle du bloc, sinon "revenir au
        # bloc" ne changeait rien du tout hors durée automatique.
        if not act.fade_overridden and not cue.auto_duration and "fadeMs" not in msg:
            act.fade_ms = max(MIN_AUTO_DURATION_MS, cue.duration_ms - act.start_offset_ms)
    if "easing" in msg:
        act.easing = msg["easing"]
    if "orientationOverridden" in msg:
        act.orientation_overridden = bool(msg["orientationOverridden"])
        # "Revenir au bloc" (bouton inspecteur) envoie
        # orientationOverridden:false seul — resynchronise depuis les
        # défauts actuels du bloc, comme le fait _apply_auto_duration
        # pour le fade juste au-dessus.
        if not act.orientation_overridden and not any(k in msg for k in orientation_keys):
            _sync_activation_orientation_defaults(cue, act)
    if "travelOrientationMode" in msg:
        act.travel_orientation_mode = msg["travelOrientationMode"] or "fixed"
    if "travelFixedYawDeg" in msg:
        act.travel_fixed_yaw_deg = float(msg["travelFixedYawDeg"] or 0.0)
    if "travelFocusPointId" in msg:
        act.travel_focus_point_id = msg["travelFocusPointId"]
    if "arrivalOrientationMode" in msg:
        act.arrival_orientation_mode = msg["arrivalOrientationMode"] or "hold"
    if "arrivalFixedYawDeg" in msg:
        act.arrival_fixed_yaw_deg = float(msg["arrivalFixedYawDeg"] or 0.0)
    if "arrivalFocusPointId" in msg:
        act.arrival_focus_point_id = msg["arrivalFocusPointId"]
    if "mountPresetId" in msg:
        # null = "ne rien changer" (le bloc ne touche pas le canal),
        # "" = "aucun preset" (efface), sinon id de preset — voir
        # Activation.mount_preset_id.
        act.mount_preset_id = msg["mountPresetId"]
    if "yawTurnMs" in msg:
        act.yaw_turn_ms = max(0.0, float(msg["yawTurnMs"] or 0.0))
    # Tracé spatial (motion path) : listes/dicts écrits tels quels,
    # null efface (retour à la ligne droite).
    if "pathPoints" in msg:
        act.path_points = msg["pathPoints"] or None
    if "startHandle" in msg:
        act.start_handle = msg["startHandle"]
    if "targetHandle" in msg:
        act.target_handle = msg["targetHandle"]
    if "curves" in msg:
        # Dict {axe: [nœuds]} du graph editor, ou None pour tout effacer.
        # Un axe portant [] ou None est retiré (retour à l'easing nommé).
        curves = msg["curves"]
        if curves is None:
            act.curves = None
        else:
            merged = dict(act.curves or {})
            for axis, nodes in curves.items():
                if nodes:
                    merged[axis] = nodes
                else:
                    merged.pop(axis, None)
            act.curves = merged or None
    cue.activations[point_id] = act
    return None


async def _handle_message(session: Session, msg: dict) -> Optional[dict]:
    """Apply one client command. Returns a reply message (error/ack) to send
    only to the requester, or None — in which case the caller broadcasts a
    fresh project snapshot to every connected client."""
    msg_type = msg.get("type")

    if msg_type in MUTATING_COMMANDS:
        session.checkpoint_undo()
    elif msg_type in RESET_UNDO_COMMANDS:
        session.reset_undo_history()

    if msg_type == "undo":
        if not session.undo():
            return {"type": "ack"}  # rien à annuler : no-op silencieux
        return None

    if msg_type == "redo":
        if not session.redo():
            return {"type": "ack"}
        return None

    if msg_type == "transport":
        # Never falls through to a project broadcast: `seek` fires on every
        # pointer-move of a cursor drag, and none of play/pause/seek touch
        # project data (points/cues/activations) — the tick loop already
        # pushes the new playhead position on its own. Broadcasting the full
        # project here too turned a mouse drag into a request storm that
        # tripped React's "Maximum update depth exceeded" guard in practice
        # (observed 2026-07-28).
        action = msg.get("action")
        if action == "play":
            session.transport.play()
        elif action == "pause":
            session.transport.pause()
        elif action == "seek":
            session.transport.seek(float(msg.get("tMs", 0.0)))
        else:
            return {"type": "error", "message": f"Unknown transport action {action!r}"}
        return {"type": "ack"}

    if msg_type == "resolve_block_context":
        # Read-only: replies to the requester, never broadcasts. The
        # frontend re-requests after every project snapshot while a block
        # is selected, so the context follows edits without the sidecar
        # having to track which client is editing which cue.
        try:
            context = resolve_block_context(session.project, msg.get("cueId", ""))
        except ValueError as exc:
            return {"type": "error", "message": str(exc)}
        return {"type": "block_context", **context}

    if msg_type == "resolve_trajectories":
        # Read-only, même principe que resolve_block_context : le frontend
        # re-demande à chaque nouvelle sélection ET à chaque nouveau
        # snapshot projet (overlay de trajectoire, mission "refonte
        # AE/Reaper" — remplace la ligne d'automation x/y/z retirée du bloc).
        result = resolve_trajectories(session.project, msg.get("pointIds", []))
        return {"type": "trajectories", **result}

    if msg_type == "set_audio":
        # Piste audio du projet (mission timeline+son). `path` charge/retire
        # le fichier ; `durationS` arrive du frontend une fois le fichier
        # decode (WebAudio/wavesurfer) — le backend n'embarque aucun codec,
        # mais c'est lui qui integre la duree au transport
        # (Project.duration_ms = max(cues, audio), deja en place).
        project = session.project
        if "path" in msg:
            project.audio_path = msg["path"] or None
            if project.audio_path is None:
                project.audio_duration_s = None
        if "durationS" in msg:
            d = msg["durationS"]
            project.audio_duration_s = float(d) if d else None
        session.timeline.rebuild()
        session.transport.set_duration(session.timeline.duration_ms)
        return None

    if msg_type == "update_psn_config":
        # Panneau Réglages PSN : tout est projet (voyage avec le bundle).
        proj = session.project
        mapping = {
            "mcastIp": ("psn_mcast_ip", str), "port": ("psn_port", int),
            "systemName": ("psn_system_name", str),
            "ifaceIp": ("psn_iface_ip", str), "rateHz": ("psn_rate_hz", int),
            "originXCm": ("transform_origin_x_cm", float),
            "originYCm": ("transform_origin_y_cm", float),
            "invertX": ("transform_invert_x", bool),
            "invertY": ("transform_invert_y", bool),
            "swapXy": ("transform_swap_xy", bool),
            "upAxis": ("transform_up_axis", str),
            # Offset global de sortie (2026-08-06) : additif, en metres,
            # applique en tout dernier dans OutputTransform.
            "outputOffsetXM": ("output_offset_x_m", float),
            "outputOffsetYM": ("output_offset_y_m", float),
            "outputOffsetZM": ("output_offset_z_m", float),
            "outputRotationDeg": ("output_rotation_deg", float),
            # Offsets d'orientation globaux (2026-08-06) : degres ajoutes
            # aux axes ori emis, fin de la chaine additive.
            "outputOriXDeg": ("output_ori_x_deg", float),
            "outputOriYDeg": ("output_ori_y_deg", float),
            "outputOriZDeg": ("output_ori_z_deg", float),
        }
        for key, (attr, cast) in mapping.items():
            if key in msg and msg[key] is not None:
                setattr(proj, attr, cast(msg[key]))
        session._apply_psn_config()
        return None

    if msg_type == "update_project_settings":
        # Réglages projet transverses (mission "refonte AE/Reaper") : pour
        # l'instant seule la vitesse de référence, qui pilote la durée des
        # blocs en "durée automatique" — sa mise à jour doit recalculer TOUS
        # les blocs concernés (elle change leur distance-par-seconde à tous),
        # contrairement à set_activation qui ne touche que le bloc édité.
        if "referenceSpeedCms" in msg and msg["referenceSpeedCms"] is not None:
            session.project.reference_speed_cms = max(1.0, float(msg["referenceSpeedCms"]))
            for cue in session.project.cues:
                if cue.auto_duration:
                    _apply_auto_duration(session.project, cue)
            session.timeline.rebuild()
            session.transport.set_duration(session.timeline.duration_ms)
        if "actorDiameterCm" in msg and msg["actorDiameterCm"] is not None:
            # Purement visuel (taille du marqueur dans la scène) : aucun
            # recalcul de timeline nécessaire, contrairement à la vitesse
            # de référence ci-dessus.
            session.project.actor_diameter_cm = max(1.0, float(msg["actorDiameterCm"]))
        # Réglages d'affichage du terrain (2026-08-06, "tous les réglages du
        # terrain doivent être dans la sauvegarde") — purement visuels, mais
        # persistés dans le projet.
        if "gridOpacity" in msg and msg["gridOpacity"] is not None:
            session.project.grid_opacity = min(1.0, max(0.0, float(msg["gridOpacity"])))
        if "gridShade" in msg and msg["gridShade"] is not None:
            session.project.grid_shade = min(1.0, max(0.0, float(msg["gridShade"])))
        if "snapToGrid" in msg and msg["snapToGrid"] is not None:
            session.project.snap_to_grid = bool(msg["snapToGrid"])
        # Remplacement/retrait du terrain 3D (2026-08-06) : null explicite =
        # retirer (le frontend retombe sur son sol générique). Le fichier
        # sera embarqué dans le zip à la prochaine sauvegarde comme les
        # autres médias.
        if "terrainGltfPath" in msg:
            v = msg["terrainGltfPath"]
            session.project.terrain_gltf_path = str(v) if v else None
        if "timecodeOffsetMs" in msg and msg["timecodeOffsetMs"] is not None:
            session.project.timecode_offset_ms = float(msg["timecodeOffsetMs"])
        return None

    if msg_type == "set_timecode_chase":
        # "Timecode In" Art-Net (2026-08-06) : armer/désarmer le suivi du
        # timecode entrant. Réglage PROJET (persisté) ; l'échec de bind du
        # port 6454 est remonté au demandeur sans laisser un état armé
        # fantôme.
        if "ifaceIp" in msg and msg["ifaceIp"]:
            session.project.timecode_iface_ip = str(msg["ifaceIp"])
        if "enabled" in msg:
            session.project.timecode_chase_enabled = bool(msg["enabled"])
        session._apply_timecode_chase()
        if session.project.timecode_chase_enabled and not session.timecode_input.running:
            session.project.timecode_chase_enabled = False
            session.transport.external_sync = False
            return {"type": "error",
                    "message": f"Art-Net timecode: {session.timecode_input.last_error or 'bind failed'}"}
        return None

    if msg_type == "list_ifaces":
        # Adresses IPv4 locales candidates pour IP_MULTICAST_IF.
        import socket as _socket
        addrs = {"0.0.0.0"}
        try:
            for info in _socket.getaddrinfo(_socket.gethostname(), None,
                                            family=_socket.AF_INET):
                addrs.add(info[4][0])
        except OSError:
            pass
        try:
            # Route par défaut : révèle l'IP de l'interface active même
            # quand gethostname ne résout pas toutes les cartes.
            probe = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
            probe.connect(("8.8.8.8", 80))
            addrs.add(probe.getsockname()[0])
            probe.close()
        except OSError:
            pass
        return {"type": "ifaces", "addresses": sorted(addrs)}

    if msg_type == "psn_preview":
        # Moniteur : EXACTEMENT ce que le broadcaster émettrait maintenant
        # (même build_trackers, même transform, même convention d'axes).
        trackers = session.broadcaster.build_trackers(session.transport.now_ms())
        return {
            "type": "psn_preview",
            "running": session.broadcaster.running,
            "packetsSent": session.broadcaster.packets_sent,
            "dest": f"{session.project.psn_mcast_ip}:{session.project.psn_port}",
            "ifaceIp": getattr(session.project, "psn_iface_ip", "0.0.0.0"),
            "rateHz": int(getattr(session.project, "psn_rate_hz", 30)),
            "upAxis": getattr(session.project, "transform_up_axis", "y"),
            "lastError": session.broadcaster.last_error,
            "trackers": [
                {"id": t.id, "name": t.name,
                 "posX": t.x_m, "posY": t.y_m, "posZ": t.z_m,
                 "oriX": t.ori_x, "oriY": t.ori_y, "oriZ": t.ori_z}
                for t in trackers
            ],
        }

    if msg_type == "update_point":
        point = session.project.point_by_id(msg.get("pointId", ""))
        if point is None:
            return {"type": "error", "message": "Unknown point id"}
        if "name" in msg:
            point.name = msg["name"]
        if "number" in msg:
            point.number = msg["number"]
        if "color" in msg:
            point.color = msg["color"]
        if "psnTrackerId" in msg:
            point.psn_tracker_id = msg["psnTrackerId"]
        if "homeZoneId" in msg:
            point.home_zone_id = msg["homeZoneId"]
        if "rosterGroupId" in msg:
            point.roster_group_id = msg["rosterGroupId"]
        if "defaultHeightCm" in msg and msg["defaultHeightCm"] is not None:
            point.default_height_cm = float(msg["defaultHeightCm"])
        if "defaultTravelOrientationMode" in msg:
            point.default_travel_orientation_mode = msg["defaultTravelOrientationMode"]
        if "isFocusPoint" in msg:
            point.is_focus_point = bool(msg["isFocusPoint"])
        if "isFocusTarget" in msg:
            point.is_focus_target = bool(msg["isFocusTarget"])
        return None

    if msg_type == "delete_point":
        session.project.delete_point(msg.get("pointId", ""))
        session.timeline.rebuild()
        return None

    if msg_type == "reorder_points":
        session.project.reorder_points(msg.get("pointIds", []))
        return None

    if msg_type == "set_roster_groups":
        # Liste complète des sous-groupes en un seul message (création/
        # renommage/suppression) — même principe que set_backstage_zones :
        # simple, sans dérive possible entre deux appels partiels.
        session.project.roster_groups = list(msg.get("groups") or [])
        session.project.prune_roster_groups()
        return None

    if msg_type == "set_fixture_mount_presets":
        # Catalogue complet des presets de montage en un seul message
        # (mission "modes d'orientation", phase D, 2026-08-04) — même
        # principe que set_roster_groups/set_backstage_zones.
        session.project.fixture_mount_presets = list(msg.get("presets") or [])
        session.project.prune_mount_presets()
        return None

    if msg_type == "psn_start":
        if not session.broadcaster.start():
            return {"type": "error", "message": session.broadcaster.last_error or "PSN start failed"}
        return None

    if msg_type == "psn_stop":
        session.broadcaster.stop()
        return None

    if msg_type == "update_stage_map":
        # Where the stage rectangle sits inside the terrain glTF's own world
        # space (position/rotation), plus the rectangle's own size — driven
        # by the drag handles on the "zone de jeu" overlay in the 3D view.
        project = session.project
        if "originXM" in msg:
            project.stage_map_origin_x_m = float(msg["originXM"])
        if "originZM" in msg:
            project.stage_map_origin_z_m = float(msg["originZM"])
        if "rotationDeg" in msg:
            project.stage_map_rotation_deg = float(msg["rotationDeg"])
        if "widthCm" in msg:
            project.stage_width_cm = max(1.0, float(msg["widthCm"]))
        if "heightCm" in msg:
            project.stage_height_cm = max(1.0, float(msg["heightCm"]))
        if "gridSizeCm" in msg:
            project.grid_size_cm = max(1.0, float(msg["gridSizeCm"]))
        if "terrainRotationDeg" in msg and msg["terrainRotationDeg"] is not None:
            project.terrain_rotation_deg = float(msg["terrainRotationDeg"])
        # The stage-map placement now feeds straight into PSN output
        # (OutputTransform.to_metres, CONCEPTION.md §4) — the live
        # broadcaster's transform must be rebuilt immediately, not just on
        # the next unrelated project reload, or a zone drag would keep
        # broadcasting from the pre-drag placement.
        session._apply_psn_config()
        return None

    if msg_type == "set_backstage_zones":
        # Liste complète des zones (création/édition/suppression en un seul
        # message — le panneau envoie l'état entier, simple et sans dérive).
        zones = []
        for z in msg.get("zones") or []:
            if not z.get("id"):
                continue
            zones.append({
                "id": str(z["id"]), "name": str(z.get("name") or "Backstage"),
                "xCm": float(z.get("xCm", 0.0)), "yCm": float(z.get("yCm", 0.0)),
                "widthCm": max(60.0, float(z.get("widthCm", 400.0))),
                "heightCm": max(60.0, float(z.get("heightCm", 400.0))),
            })
        session.project.backstage_zones = zones
        session.project.ensure_backstage()
        return None

    if msg_type == "add_point":
        pid = msg.get("id") or str(uuid.uuid4())
        session.project.points.append(Point(
            id=pid, name=msg.get("name", "Point"), number=msg.get("number"),
            color=msg.get("color", "#4F6DF5"),
            roster_group_id=msg.get("rosterGroupId"),
            is_focus_point=bool(msg.get("isFocusPoint", False)),
        ))
        # Attache backstage immédiate : le nouvel acteur apparaît dans sa
        # zone au lieu d'être invisible (mission backstage).
        session.project.ensure_backstage()
        return None

    if msg_type == "add_cue":
        cue = Cue(
            id=msg.get("id") or str(uuid.uuid4()),
            name=msg.get("name", "Cue"),
            start_ms=float(msg.get("startMs", session.project.next_start_ms())),
            duration_ms=float(msg.get("durationMs", 1000.0)),
            color=msg.get("color", "#4F6DF5"),
            lane=max(0, int(msg.get("lane", 0))),
            # Défauts d'orientation d'un bloc NEUF (demande Florian
            # 2026-08-05) : trajet "suivre la trajectoire", arrivée "ne
            # change pas" — le comportement le plus naturel pour un acteur
            # porté. Les blocs existants (chargés) gardent leurs défauts.
            default_travel_orientation_mode="path",
            default_arrival_orientation_mode="hold",
            # Fade orientation par défaut 0,5 s (demande Florian
            # 2026-08-06, ex-"temps de rotation") — les nouvelles
            # activations du bloc en héritent via la resynchronisation.
            default_yaw_turn_ms=500.0,
        )
        session.project.cues.append(cue)
        _resolve_lane_overlap(session.project, cue)
        session.project.sort_cues()
        session.timeline.rebuild()
        session.transport.set_duration(session.timeline.duration_ms)
        return None

    if msg_type == "update_cue":
        cue = session.project.cue_by_id(msg.get("cueId", ""))
        if cue is None:
            return {"type": "error", "message": "Unknown cue id"}
        # Mode APERCU (2026-08-07) : le geste libre 'trou' etire le bloc a
        # chaque echantillon (startMs/durationMs) — en preview on applique
        # la fenetre + le resync leger des fades, on rebuild, on ack ; le
        # relogement anti-superposition et la rediffusion attendent
        # l'ecriture finale du relachement.
        if msg.get("preview"):
            if "startMs" in msg:
                cue.start_ms = float(msg["startMs"])
            if "durationMs" in msg:
                cue.duration_ms = float(msg["durationMs"])
                if not cue.auto_duration:
                    for act in cue.activations.values():
                        if not act.fade_overridden:
                            act.fade_ms = max(
                                MIN_AUTO_DURATION_MS, cue.duration_ms - act.start_offset_ms)
            session.project.sort_cues()
            session.timeline.rebuild()
            return {"type": "ack"}
        if "name" in msg:
            cue.name = msg["name"]
        if "startMs" in msg:
            cue.start_ms = float(msg["startMs"])
        if "durationMs" in msg:
            cue.duration_ms = float(msg["durationMs"])
            # Un redimensionnement DIRECT du bloc (glisser son bord dans la
            # timeline) est le bloc qui redéfinit son propre défaut : les
            # acteurs non personnalisés suivent (mission "global vs
            # sélectif"). Exclu si ce message touche AUSSI autoDuration
            # (ex. bouton preset qui vient de calculer un fade PAR ACTEUR
            # avant de désactiver la durée automatique dans le même appel —
            # écraser ces valeurs ici serait la régression inverse).
            if not cue.auto_duration and "autoDuration" not in msg:
                for act in cue.activations.values():
                    if not act.fade_overridden:
                        # Termine PILE à la fin du bloc, décalage de départ
                        # déduit — pas cue.duration_ms tel quel, sinon un
                        # acteur décalé déborderait du bloc.
                        act.fade_ms = max(
                            MIN_AUTO_DURATION_MS, cue.duration_ms - act.start_offset_ms)
        if "color" in msg:
            cue.color = msg["color"]
        if "lane" in msg:
            cue.lane = max(0, int(msg["lane"]))
        if "autoDuration" in msg:
            cue.auto_duration = bool(msg["autoDuration"])
            # Activer la case recalcule tout de suite (sinon la durée reste
            # celle réglée à la main jusqu'à la prochaine activation touchée
            # — trompeur, la case semblerait ne rien faire).
            if cue.auto_duration:
                _apply_auto_duration(session.project, cue)
        orientation_default_keys = (
            "defaultTravelOrientationMode", "defaultTravelFixedYawDeg",
            "defaultTravelFocusPointId", "defaultArrivalOrientationMode",
            "defaultArrivalFixedYawDeg", "defaultArrivalFocusPointId",
            "defaultMountPresetId", "defaultYawTurnMs",
        )
        if "defaultTravelOrientationMode" in msg:
            cue.default_travel_orientation_mode = msg["defaultTravelOrientationMode"]
        if "defaultTravelFixedYawDeg" in msg:
            cue.default_travel_fixed_yaw_deg = msg["defaultTravelFixedYawDeg"]
        if "defaultTravelFocusPointId" in msg:
            cue.default_travel_focus_point_id = msg["defaultTravelFocusPointId"]
        if "defaultArrivalOrientationMode" in msg:
            cue.default_arrival_orientation_mode = msg["defaultArrivalOrientationMode"]
        if "defaultArrivalFixedYawDeg" in msg:
            cue.default_arrival_fixed_yaw_deg = msg["defaultArrivalFixedYawDeg"]
        if "defaultArrivalFocusPointId" in msg:
            cue.default_arrival_focus_point_id = msg["defaultArrivalFocusPointId"]
        if "defaultMountPresetId" in msg:
            cue.default_mount_preset_id = msg["defaultMountPresetId"]
        if "defaultYawTurnMs" in msg:
            cue.default_yaw_turn_ms = msg["defaultYawTurnMs"]
        if any(k in msg for k in orientation_default_keys):
            _apply_cue_orientation_defaults(cue)
        if any(k in msg for k in ("startMs", "durationMs", "lane")):
            _resolve_lane_overlap(session.project, cue)
        session.project.sort_cues()
        session.timeline.rebuild()
        session.transport.set_duration(session.timeline.duration_ms)
        return None

    if msg_type == "delete_cue":
        cue_id = msg.get("cueId")
        session.project.cues = [c for c in session.project.cues if c.id != cue_id]
        session.timeline.rebuild()
        session.transport.set_duration(session.timeline.duration_ms)
        return None

    if msg_type == "set_activation":
        cue = session.project.cue_by_id(msg.get("cueId", ""))
        if cue is None:
            return {"type": "error", "message": "Unknown cue id"}
        # Mode APERCU (2026-08-07) — meme contrat que set_activations :
        # applique + rebuild, PAS de rediffusion (ack), auto-duration
        # sautee. Necessaire aussi ici : le drag d'UN acteur/waypoint/
        # poignee passe par set_activation, et chaque echantillon mutant
        # empilait une rediffusion complete ('le chemin se fait mais en
        # retard' apres le relachement).
        if msg.get("preview"):
            err = _apply_activation_patch(session, cue, msg)
            if err is not None:
                return err
            session.timeline.rebuild()
            return {"type": "ack"}
        err = _apply_activation_patch(session, cue, msg)
        if err is not None:
            return err
        # Durée automatique (mission "refonte AE/Reaper") : seul ce bloc peut
        # avoir changé de distance à parcourir, jamais ses voisins — recalcul
        # ciblé, pas un balayage de tout le projet à chaque frappe.
        if cue.auto_duration:
            _apply_auto_duration(session.project, cue)
        session.timeline.rebuild()
        session.transport.set_duration(session.timeline.duration_ms)
        return None

    if msg_type == "set_activations":
        # Écriture GROUPÉE (optimisation 2026-08-06, "le déplacement de
        # plusieurs points en même temps fait ramer") : un geste multi-
        # acteurs envoyait N set_activation par échantillon, et CHAQUE
        # message déclenchait une re-sérialisation + diffusion du projet
        # ENTIER — N diffusions et N re-rendus frontend là où une seule
        # suffit. Ce message applique toutes les entrées d'un coup : une
        # seule passe auto-duration/rebuild, UNE seule diffusion.
        cue = session.project.cue_by_id(msg.get("cueId", ""))
        if cue is None:
            return {"type": "error", "message": "Unknown cue id"}
        for entry in msg.get("entries") or []:
            err = _apply_activation_patch(session, cue, entry)
            if err is not None:
                return err
        # Mode APERÇU (2026-08-07, "ça rame toujours" avec 78 acteurs) :
        # pendant un geste continu, le frontend marque ses échantillons
        # preview:true — on saute la passe auto-duration (recalcul des
        # fades de TOUT le bloc, O(P) répété 10-30x/s) et SURTOUT la
        # rediffusion du projet complet (voir le return {"type":"ack"}
        # ci-dessous : un reply non-None court-circuite le broadcast).
        # Le rebuild reste : le tick à 30 Hz porte les positions résolues,
        # c'est LUI le retour visuel du geste. L'écriture FINALE du geste
        # (pointerup) arrive sans preview et paie tout une seule fois.
        if msg.get("preview"):
            session.timeline.rebuild()
            return {"type": "ack"}
        if cue.auto_duration:
            _apply_auto_duration(session.project, cue)
        session.timeline.rebuild()
        session.transport.set_duration(session.timeline.duration_ms)
        return None


    if msg_type == "apply_group_transform":
        cue = session.project.cue_by_id(msg.get("cueId", ""))
        if cue is None:
            return {"type": "error", "message": "Unknown cue id"}
        session.project.apply_group_transform(
            cue, msg.get("pointIds", []),
            pivot=tuple(msg.get("pivot", (0.0, 0.0))),
            translate=tuple(msg.get("translate", (0.0, 0.0))),
            rotate_deg=float(msg.get("rotateDeg", 0.0)),
            fade_ms=float(msg.get("fadeMs", 1000.0)),
            easing=msg.get("easing", "linear"),
        )
        return None

    if msg_type == "import_stancz":
        project = import_stancz(msg["path"])
        project.ensure_backstage()
        session.set_project(project)
        return None

    if msg_type == "new_project":
        project = Project(name=msg.get("name", "Untitled"))
        project.ensure_backstage()
        session.set_project(project)
        return None

    if msg_type == "save_bundle":
        # msg["path"] est le chemin complet du FICHIER .lumitrack (format
        # 2026-07-31 : le fichier porte l'extension, pas le dossier —
        # l'ancien contenu à ce chemin, s'il existe, est archivé avant
        # d'être écrasé, voir core/project.py::save_bundle). save_bundle
        # peut CORRIGER le chemin (dossier dédié inséré si besoin) : on
        # renvoie le chemin RÉEL, pas l'écho brut de la demande, sinon le
        # frontend retiendrait un "chemin courant" qui n'existe pas.
        real_path = save_bundle(session.project, msg["path"])
        return {"type": "saved", "path": real_path}

    if msg_type == "list_bundle_archive":
        # Lecture seule pour le panneau "Historique des versions" : répond
        # au seul demandeur, jamais de broadcast (même principe que
        # resolve_block_context).
        return {"type": "bundle_archive", "path": msg["path"],
                "entries": list_archive(msg["path"])}

    if msg_type == "load_bundle":
        session.set_project(load_bundle(msg["path"], msg.get("archivedName")))
        return None

    # ---- Cycle de vie du fichier de secours (2026-08-07) ----
    if msg_type == "clean_exit":
        # Sortie PROPRE (que l'utilisateur ait sauvegardé ou non) : le
        # fichier de secours n'a plus de raison d'être, et la boucle
        # d'écriture est gelée pour qu'une dernière mutation en vol ne le
        # recrée pas juste avant le kill du process.
        session.exiting = True
        try:
            os.remove(rescue_path())
        except FileNotFoundError:
            pass
        return {"type": "ack"}

    if msg_type == "load_rescue":
        path = rescue_path()
        session.rescue_available = False
        if os.path.isfile(path):
            project = Project.load(path)
            _sanitize_all_lanes(project)
            session.set_project(project)
            return None
        return {"type": "error", "message": "Aucun fichier de secours"}

    if msg_type == "discard_rescue":
        session.rescue_available = False
        try:
            os.remove(rescue_path())
        except FileNotFoundError:
            pass
        return {"type": "ack"}

    return {"type": "error", "message": f"Unknown message type {msg_type!r}"}


async def _client_handler(session: Session, websocket):
    session.clients.add(websocket)
    try:
        await websocket.send(json.dumps(session.project_message()))
        # Crash détecté à la session précédente : proposer la récupération
        # (une seule fois — load_rescue/discard_rescue baissent le drapeau).
        if session.rescue_available:
            await websocket.send(json.dumps({"type": "rescue_available"}))
        async for raw in websocket:
            try:
                msg = json.loads(raw)
                reply = await _handle_message(session, msg)
            except Exception as exc:  # noqa: BLE001 - report to client, keep serving
                logger.exception("Error handling message")
                reply = {"type": "error", "message": str(exc)}
            if reply is not None:
                await websocket.send(json.dumps(reply))
            else:
                # Toute commande qui aboutit à un broadcast de projet est une
                # mutation : elle arme l'autosauvegarde débouncée.
                session.dirty = True
                await session.broadcast(session.project_message())
    finally:
        session.clients.discard(websocket)


async def _run(host: str, port: int):
    session = Session()
    asyncio.create_task(_tick_loop(session))
    asyncio.create_task(_autosave_loop(session))
    async with websockets.serve(lambda ws: _client_handler(session, ws), host, port):
        logger.info("Lumitrack sidecar listening on ws://%s:%s", host, port)
        await asyncio.Future()  # run forever


def main() -> int:
    parser = argparse.ArgumentParser(description="Lumitrack Python sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=17845)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        asyncio.run(_run(args.host, args.port))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
