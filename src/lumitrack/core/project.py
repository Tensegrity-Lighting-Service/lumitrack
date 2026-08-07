"""Data model for a choreography project, plus .stancz import.

Internal units are **centimetres** with the origin at the top-left of the
stage, matching Stancz's own convention. Conversion to metres for PSN happens
only at the output stage (see core.psn / core.timeline.OutputTransform).

V2 data model (see CONCEPTION.md §12.1/§13.1): the sequential cumulative
"Formation" of v0.1 is replaced by **Cue** blocks that can overlap in time.
A Cue is empty until points are explicitly **activated** in it; each
Activation carries its own fade time/easing and may set any subset of
(x, y, z, yaw) — a field left as None is simply not touched by that
activation and keeps tracking its last known value (see core.timeline for
the resolution algorithm). Relative group moves (translate/rotate around a
pivot) are an authoring-time helper (`apply_group_transform`) that bakes
straight into per-point absolute Activations: the model itself never stores
a "relative" state.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import sys
import tempfile
import uuid
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

PROJECT_FORMAT = "Lumitrack"
# Version du SCHÉMA de sauvegarde (2026-08-06, "met un marqueur dans la
# sauvegarde avec la version") : à INCRÉMENTER UNIQUEMENT quand le FORMAT
# des données change (nouveau champ, sémantique modifiée) — jamais pour un
# changement d'UI pur (précision Florian 2026-08-07 : "uniquement si il y a
# un changement qui impacte la sauvegarde et non pas l'UI"). Un build 0.3.x
# bêta qui ne touche que l'interface garde donc la même version de schéma,
# et ses sauvegardes restent ouvrables par le canal stable — le refus
# d'ouverture ne se déclenche qu'entre schémas réellement différents.
# Pourquoi refuser : une app à schéma N qui re-sauvegarderait un fichier de
# schéma N+1 PERDRAIT silencieusement les champs qu'elle ne connaît pas.
# from_dict REFUSE d'ouvrir un fichier de version supérieure ("mettez à
# jour Lumitrack") — ouvrir un fichier plus ancien reste toujours possible
# (les champs manquants prennent leurs valeurs par défaut).
# v3 (2026-08-06) : offsets d'orientation globaux + rY par preset,
# marqueur appVersion.
# v4 (2026-08-07) : timing par waypoint (pathPoints[].tFrac, optionnel) —
# une sauvegarde v4 ouverte par une app antérieure perdrait ces timings,
# d'où le bump ; les sauvegardes v3 s'ouvrent inchangées (tFrac absent =
# répartition par longueur d'arc, comportement historique).
PROJECT_VERSION = 4
# Version de l'APP qui a écrit le fichier — purement informatif (message
# d'erreur utile, diagnostic). À garder alignée sur tauri.conf.json.
APP_VERSION = "0.3.0"

# Marqueur de l'ancien format de bundle (dossier = paquet, manifest.json +
# media/ + versions/) — conservé uniquement pour la lecture rétrocompatible,
# voir `_load_legacy_directory_bundle`. Le nouveau format (fichier .lumitrack
# + media/ + archive/, 2026-07-31) n'a pas de manifest séparé : le fichier
# JSON lui-même porte déjà format/version via Project.to_dict().
BUNDLE_FORMAT = "lumitrack-bundle"
BUNDLE_VERSION = 1

DEFAULT_HEIGHT_CM = 150.0  # plausible carried-fixture height; per-actor & animatable


@dataclass
class Point:
    """One controllable point. In this app a point is a lighting fixture
    carried by an operator, not a dancer."""
    id: str
    name: str
    number: Optional[int] = None
    color: str = "#4F6DF5"
    psn_tracker_id: Optional[int] = None  # falls back to `number` when None
    default_height_cm: float = DEFAULT_HEIGHT_CM
    # Zone backstage d'attache (mission backstage 2026-07-29) : là où
    # l'acteur EXISTE tant qu'aucune activation ne l'a saisi — visible en
    # scène et émis en PSN. None -> première zone du projet.
    home_zone_id: Optional[str] = None
    # Sous-groupe du ROSTER (mission "hiérarchie du roster", 2026-07-31) :
    # purement organisationnel — ordonner la vue, faciliter la sélection et
    # le glisser-déposer d'un ensemble d'acteurs. Sans rapport avec les
    # groupes animables du §12.2 (reportés en v1.1, LTP inter-groupes,
    # appartenance multiple) : un acteur appartient à AU PLUS UN sous-groupe,
    # comme un dossier de fichiers. None = pas de sous-groupe.
    roster_group_id: Optional[str] = None
    # Préremplissage des NOUVELLES activations de cet acteur (menu contextuel
    # roster/scène, DIRECTIVES.md point 5) — n'a aucune autorité sur les
    # activations déjà réglées, purement une commodité de saisie. Ne touche
    # jamais la résolution de lecture (Activation.travel_orientation_mode
    # reste la seule valeur qui compte une fois l'activation créée) : pas de
    # miroir Rust nécessaire. Renommé de default_orientation_mode (2026-08-04,
    # mission "modes d'orientation") : c'est maintenant un repli pour la
    # phase TRAJET uniquement (l'arrivée retombe toujours sur "hold").
    default_travel_orientation_mode: str = "fixed"
    # Point de focus (mission "modes d'orientation", 2026-08-04) : un simple
    # repère de visée, pas un acteur réel — pas d'orientation propre, jamais
    # émis en PSN (core/engine.py::Broadcaster.build_trackers), jamais placé
    # dans la grille backstage (timeline.py::backstage_slot). Contrairement
    # à roster_group_id/default_orientation_mode (conventions d'édition
    # pures), CE champ affecte la résolution (backstage_slot) — miroir Rust
    # nécessaire (native/src/model.rs::Point).
    is_focus_point: bool = False
    # Un VRAI acteur qui sert AUSSI de cible de visée (demande 2026-08-06,
    # "une chanteuse") : reste émis en PSN et placé backstage comme
    # n'importe quel acteur — la seule différence est d'apparaître dans les
    # listes de choix de focus du frontend. La résolution vise par id
    # (resolved_xy), peu importe le type de point : convention d'édition
    # pure, pas de miroir Rust.
    is_focus_target: bool = False

    def resolved_tracker_id(self, fallback_index: int) -> int:
        if self.psn_tracker_id is not None:
            return int(self.psn_tracker_id) & 0xFFFF
        if self.number is not None:
            return int(self.number) & 0xFFFF
        return fallback_index & 0xFFFF

    # camelCase on the wire (JSON files + WebSocket protocol), to match both
    # the outer Project fields and the sidecar's live-edit commands.
    def to_dict(self) -> dict:
        return {
            "id": self.id, "name": self.name, "number": self.number,
            "color": self.color, "psnTrackerId": self.psn_tracker_id,
            "defaultHeightCm": self.default_height_cm,
            "homeZoneId": self.home_zone_id,
            "rosterGroupId": self.roster_group_id,
            "defaultTravelOrientationMode": self.default_travel_orientation_mode,
            "isFocusPoint": self.is_focus_point,
            "isFocusTarget": self.is_focus_target,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Point":
        mode = d.get("defaultTravelOrientationMode")
        if mode is None:
            # Old format (pre-2026-08-04): defaultOrientationMode was
            # 'manual'|'path'|'focus' for a single (unsplit) travel/arrival
            # setting. 'manual' (smoothly-animated yaw) has no equivalent
            # anymore -> becomes the new instantaneous 'fixed'.
            old = d.get("defaultOrientationMode", "manual")
            mode = "fixed" if old == "manual" else old
        return cls(
            id=d["id"], name=d.get("name", ""), number=d.get("number"),
            color=d.get("color", "#4F6DF5"), psn_tracker_id=d.get("psnTrackerId"),
            default_height_cm=float(d.get("defaultHeightCm", DEFAULT_HEIGHT_CM)),
            home_zone_id=d.get("homeZoneId"),
            roster_group_id=d.get("rosterGroupId"),
            default_travel_orientation_mode=mode,
            is_focus_point=bool(d.get("isFocusPoint", False)),
            is_focus_target=bool(d.get("isFocusTarget", False)),
        )


@dataclass
class Activation:
    """One point's movement within a Cue block. Any of the target_* fields
    may be None, meaning this activation does not touch that axis for this
    point (it keeps tracking whatever value it last had)."""
    target_x_cm: Optional[float] = None
    target_y_cm: Optional[float] = None
    target_z_cm: Optional[float] = None
    fade_ms: float = 1000.0
    easing: str = "linear"
    # Mission "global vs sélectif" (2026-08-03) : marque un fade_ms modifié
    # à la main par l'utilisateur (pas par la "durée automatique" du bloc).
    # Une activation personnalisée sort du recalcul automatique tant
    # qu'elle reste personnalisée (voir sidecar._apply_auto_duration) — et
    # peut revenir dans le rang via "revenir au réglage du bloc"
    # (set_activation avec fadeOverridden=false, qui la recalcule une
    # dernière fois puis la remet sous contrôle de la durée automatique).
    fade_overridden: bool = False
    # Mission "global vs sélectif", décalage de départ (2026-08-03,
    # DIRECTIVES.md point 6) : cette activation démarre (et gouverne LTP)
    # `start_offset_ms` après le début nominal du bloc (cue.start_ms), pas
    # exactement dessus — permet des entrées en escalier/vague quand
    # plusieurs acteurs partagent un bloc. 0 = comportement historique
    # (démarre pile avec le bloc). Jamais négatif (un acteur ne peut pas
    # démarrer AVANT le bloc qui le contient — sortirait de la cohérence
    # des tracks LTP, qui suppose un bloc = une fenêtre bien à lui).
    start_offset_ms: float = 0.0
    # Mission "modes d'orientation" (2026-08-04, remplace la v1 du 08-01) :
    # le lacet se règle en DEUX phases indépendantes plutôt qu'un seul mode
    # pour toute l'activation — "en trajet" (pendant le fondu) et "à
    # l'arrivée" (pendant le maintien). L'ancien mode "manual" (lacet animé
    # en douceur comme x/y/z, via target_yaw_deg) disparaît entièrement :
    # tout devient discret (Florian, confirmé explicitement — "non tout
    # devient discret"). Résolu dans timeline.py::_resolve_yaw (miroir
    # Rust : native/src/timeline.rs) — jamais dans le frontend (§13.1.7).
    #
    # En trajet — "fixed" (angle unique, JAMAIS animé/interpolé, contraste
    # avec l'ancien "manual" qui l'était) ; "path" (tangente de la
    # trajectoire spatiale résolue de CE point à cet instant, comportement
    # inchangé) ; "focus" (vise en continu un POINT DE FOCUS choisi —
    # travel_focus_point_id référence un Point.is_focus_point, plus des
    # coordonnées brutes).
    travel_orientation_mode: str = "fixed"
    travel_fixed_yaw_deg: float = 0.0
    travel_focus_point_id: Optional[str] = None
    # À l'arrivée — "hold" ("ne change pas" : fige ce que le trajet avait
    # résolu pile à l'instant où le fondu se termine — généralise l'ancien
    # comportement de "path", qui gelait déjà la dernière direction de
    # marche pendant le maintien, à TOUS les modes de trajet) ; "fixed" (son
    # propre angle, INDÉPENDANT de celui du trajet) ; "focus" (son propre
    # point de focus, lui aussi indépendant de celui du trajet — confirmé
    # par Florian : les deux phases ne partagent jamais la même référence).
    arrival_orientation_mode: str = "hold"
    arrival_fixed_yaw_deg: float = 0.0
    arrival_focus_point_id: Optional[str] = None
    # Temps de rotation (2026-08-05, "ajouter le temps de rotation qui pour
    # le moment est cut") : durée (ms) du fondu du lacet aux TRANSITIONS —
    # à l'entrée de la fenêtre de l'activation (depuis la valeur qui
    # gouvernait juste avant) et à la bascule trajet→arrivée. 0 = cut
    # (comportement depuis la refonte du 08-04). Toujours en plus court
    # chemin angulaire, easing smoothstep — ce n'est PAS le retour de
    # l'ancien lacet animé "manual" : la CIBLE reste discrète/dérivée, seul
    # le raccord est adouci. Lu par la résolution (timeline.py::_resolve_yaw)
    # → miroir Rust obligatoire.
    yaw_turn_ms: float = 0.0
    # Mission "global vs sélectif" étendue à l'orientation (2026-08-04,
    # même principe que fade_overridden) : marque une personnalisation
    # manuelle qui sort du réglage par défaut du bloc (Cue.default_travel_*/
    # default_arrival_*) tant qu'elle reste personnalisée. Contrairement à
    # fade_overridden, CE champ EST lu au moment de la résolution (via
    # touches_orientation() ci-dessous, pour le cas d'une activation de pure
    # rotation sans x/y) — miroir Rust nécessaire, exception documentée.
    orientation_overridden: bool = False
    # Preset de montage de fixture (phase D, recadré 2026-08-04 : "pas un
    # preset au niveau PSN, mais au niveau des acteurs dans les blocs, avec
    # option ne rien changer") — PAR ACTIVATION, comme les cibles d'axes :
    # None = "ne rien changer" (ce bloc ne touche pas le canal, le preset
    # gouvernant précédent continue, LTP) ; "" = "aucun preset" (efface
    # explicitement la correction) ; sinon id d'une entrée de
    # Project.fixture_mount_presets. Résolu au moment de l'ÉMISSION PSN
    # uniquement (core/engine.py::governing_mount_preset) — jamais lu par
    # la résolution de lecture : pas de miroir Rust.
    mount_preset_id: Optional[str] = None
    # Graph editor (mission 2026-07-29, spec = KeysView de Friction) :
    # courbes d'easing personnalisées PAR AXE. {"x"|"y"|"z"|"yaw": [node]}.
    # node = {"t": 0..1, "v": progrès, "inT"/"inV"/"outT"/"outV": poignées
    # Bézier ABSOLUES (ou None), "mode": "smooth"|"symmetric"|"corner"}.
    # Un axe absent du dict retombe sur l'easing nommé — les bundles
    # existants restent valides sans migration.
    curves: Optional[dict] = None
    # Tracé spatial courbe (mission "motion path", spec AE) : points de
    # passage ENTRE le départ (dynamique, résolu par le tracking) et la
    # cible. Chaque waypoint = {"xCm","yCm"} absolus + poignées RELATIVES
    # {"inDxCm","inDyCm","outDxCm","outDyCm"} (None = tiers de corde =
    # quasi-droit). start_handle/target_handle : poignée sortante du départ /
    # entrante de la cible, en offsets relatifs {"dxCm","dyCm"}. Tout à None
    # -> ligne droite (comportement historique, bundles inchangés).
    path_points: Optional[list] = None
    start_handle: Optional[dict] = None
    target_handle: Optional[dict] = None

    def has_spatial_path(self) -> bool:
        return bool(self.path_points) or self.start_handle is not None \
            or self.target_handle is not None

    def touches(self) -> bool:
        return any(v is not None for v in
                   (self.target_x_cm, self.target_y_cm, self.target_z_cm))

    def touches_orientation(self) -> bool:
        """A real x/y move governs the yaw resolution; a pure-rotation
        activation (no movement at all) only governs it if the user
        explicitly personalized it (see orientation_overridden). target_z_cm
        deliberately excluded: a height-only change shouldn't steal facing
        control from whatever activation last set it."""
        return (self.target_x_cm is not None or self.target_y_cm is not None
                or self.orientation_overridden)

    def to_dict(self) -> dict:
        return {
            "targetXCm": self.target_x_cm, "targetYCm": self.target_y_cm,
            "targetZCm": self.target_z_cm,
            "fadeMs": self.fade_ms, "easing": self.easing,
            "fadeOverridden": self.fade_overridden,
            "startOffsetMs": self.start_offset_ms,
            "orientationOverridden": self.orientation_overridden,
            "travelOrientationMode": self.travel_orientation_mode,
            "travelFixedYawDeg": self.travel_fixed_yaw_deg,
            "travelFocusPointId": self.travel_focus_point_id,
            "arrivalOrientationMode": self.arrival_orientation_mode,
            "arrivalFixedYawDeg": self.arrival_fixed_yaw_deg,
            "arrivalFocusPointId": self.arrival_focus_point_id,
            "yawTurnMs": self.yaw_turn_ms,
            "mountPresetId": self.mount_preset_id,
            "curves": self.curves,
            "pathPoints": self.path_points,
            "startHandle": self.start_handle,
            "targetHandle": self.target_handle,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Activation":
        return cls(
            target_x_cm=d.get("targetXCm"), target_y_cm=d.get("targetYCm"),
            target_z_cm=d.get("targetZCm"),
            fade_ms=float(d.get("fadeMs", 1000.0)), easing=d.get("easing", "linear"),
            fade_overridden=bool(d.get("fadeOverridden", False)),
            start_offset_ms=max(0.0, float(d.get("startOffsetMs", 0.0))),
            orientation_overridden=bool(d.get("orientationOverridden", False)),
            travel_orientation_mode=d.get("travelOrientationMode", "fixed"),
            travel_fixed_yaw_deg=float(d.get("travelFixedYawDeg", 0.0)),
            travel_focus_point_id=d.get("travelFocusPointId"),
            arrival_orientation_mode=d.get("arrivalOrientationMode", "hold"),
            arrival_fixed_yaw_deg=float(d.get("arrivalFixedYawDeg", 0.0)),
            arrival_focus_point_id=d.get("arrivalFocusPointId"),
            yaw_turn_ms=max(0.0, float(d.get("yawTurnMs", 0.0))),
            mount_preset_id=d.get("mountPresetId"),
            curves=d.get("curves"),
            path_points=d.get("pathPoints"),
            start_handle=d.get("startHandle"),
            target_handle=d.get("targetHandle"),
        )


@dataclass
class Cue:
    """A block on the timeline with a real displayed duration. Empty at
    creation; activations are added per point. Cues are free to overlap in
    time and in the set of points they touch."""
    id: str
    name: str
    start_ms: float
    duration_ms: float
    activations: dict = field(default_factory=dict)  # point_id -> Activation
    color: str = "#4F6DF5"
    # Mission "refonte AE/Reaper" (2026-08-01) : quand actif, duration_ms
    # suit automatiquement la distance/vitesse de référence du projet (voir
    # timeline.required_duration_ms) au lieu d'être réglé à la main — recalculé
    # par le sidecar à chaque activation touchée ou changement de la vitesse
    # de référence. Défaut False : n'affecte aucun projet existant tant que
    # personne n'a coché la case.
    auto_duration: bool = False
    # Piste de la timeline (mission multi-pistes 2026-07-29) : les blocs se
    # placent LIBREMENT sur une piste choisie, ils ne sont plus empilés
    # automatiquement. Migration : projets sans "lane" -> empaquetage
    # glouton une seule fois au chargement (from_dict).
    lane: int = 0
    # Réglage par défaut du BLOC pour l'orientation (mission "modes
    # d'orientation", 2026-08-04) — même esprit que le timing (point 6
    # DIRECTIVES.md) : None = pas encore réglé, chaque nouvelle activation
    # du bloc retombe alors sur Point.default_travel_orientation_mode/
    # "hold". Une fois réglé ici, sert de préremplissage pour toute
    # NOUVELLE activation du bloc et resynchronise (sidecar
    # ._apply_cue_orientation_defaults) toute activation existante avec
    # orientation_overridden=False. N'affecte jamais la résolution
    # elle-même (Activation porte les valeurs qui comptent) : pas de
    # miroir Rust, comme duration_ms/auto_duration.
    default_travel_orientation_mode: Optional[str] = None
    default_travel_fixed_yaw_deg: Optional[float] = None
    default_travel_focus_point_id: Optional[str] = None
    default_arrival_orientation_mode: Optional[str] = None
    default_arrival_fixed_yaw_deg: Optional[float] = None
    default_arrival_focus_point_id: Optional[str] = None
    # Preset d'orientation par défaut du bloc (demande Florian 2026-08-05,
    # "cela fait sens avec l'option orientation par défaut du bloc") — même
    # mécanique que les 6 défauts ci-dessus : None = jamais réglé (les
    # activations gardent leur valeur), "" = défaut explicite "ne rien
    # changer" (resynchronise les non-personnalisées à None), sinon id d'un
    # preset de Project.fixture_mount_presets.
    default_mount_preset_id: Optional[str] = None
    # Temps de rotation par défaut du bloc (2026-08-05, même famille) —
    # None = jamais réglé, sinon millisecondes (voir Activation.yaw_turn_ms).
    default_yaw_turn_ms: Optional[float] = None

    def activation_end_ms(self) -> float:
        """Latest moment any activation in this cue is still fading."""
        ends = [self.start_ms + a.fade_ms for a in self.activations.values()]
        return max(ends, default=self.start_ms)


@dataclass
class Project:
    name: str = "Untitled"
    stage_width_cm: float = 5000.0
    stage_height_cm: float = 3000.0
    grid_size_cm: float = 50.0
    points: list = field(default_factory=list)  # list[Point]
    cues: list = field(default_factory=list)     # list[Cue]
    # Zones backstage : rectangles nommés en coordonnées scène (souvent HORS
    # de la zone de jeu) — points d'entrée/sortie des acteurs. Un acteur
    # sans activation vit dans sa zone (grille auto, voir
    # timeline.backstage_slot) et le PSN l'émet.
    backstage_zones: list = field(default_factory=list)  # [{id,name,xCm,yCm,widthCm,heightCm}]
    # Sous-groupes du roster (voir Point.roster_group_id) : [{id, name}].
    # Purement organisationnel, l'ordre du roster reste porté par `points`
    # lui-même (l'ordre de la liste = l'ordre affiché).
    roster_groups: list = field(default_factory=list)
    # Presets de montage de fixture (mission "modes d'orientation", phase D,
    # 2026-08-04) : catalogue PROJET, éditable/ajoutable (pas un enum codé en
    # dur — "vertical"/"horizontal"/"posé au sol" ne sont que des LIGNES
    # créées par l'utilisateur). Complète ce que le graphe d'animation ne
    # gère pas (tangage/roulis), dérivé du lacet déjà résolu au moment de
    # l'émission PSN (core/engine.py::apply_mount_preset) — jamais une
    # nouvelle timeline d'animation. [{id, name, basePitchDeg, baseRollDeg,
    # pitchTracksYaw, rollTracksYaw}].
    fixture_mount_presets: list = field(default_factory=list)
    floor_image_path: Optional[str] = None
    terrain_gltf_path: Optional[str] = None
    audio_path: Optional[str] = None
    audio_duration_s: Optional[float] = None
    bpm: Optional[float] = None
    # Offset between incoming timecode and project time zero.
    # 1 h par défaut (demande 2026-08-06) : convention répandue de caler le
    # début du show à 01:00:00:00 — un NOUVEAU projet suit le TC de régie
    # sans réglage. Les projets existants gardent leur valeur sauvegardée.
    timecode_offset_ms: float = 3_600_000.0
    # PSN output settings that travel with the project (§13.1.9).
    psn_system_name: str = "Lumitrack"
    psn_mcast_ip: str = "236.10.10.10"
    psn_port: int = 56565
    # Interface réseau de sortie (0.0.0.0 = choix de l'OS) et fréquence
    # d'émission (mission panneau PSN 2026-07-29).
    psn_iface_ip: str = "0.0.0.0"
    psn_rate_hz: int = 30
    transform_origin_x_cm: float = 0.0
    transform_origin_y_cm: float = 0.0
    transform_invert_x: bool = False
    transform_invert_y: bool = False
    transform_swap_xy: bool = False
    # Convention d'axe vertical de la sortie PSN. La spec officielle 2.03
    # (p.8) est explicite : « positive x is right, positive y is up and
    # positive z is depth » — Y VERTICAL (Capture suit la spec ; MA Lighting
    # est co-auteur). "y" (défaut, conforme) envoie (x, hauteur, profondeur)
    # et le lacet en ori_y ; "z" (héritage) envoie la hauteur en Z et le
    # lacet en ori_z, pour les outils qui dévient de la spec.
    transform_up_axis: str = "y"
    # Where the stage rectangle (stage_width_cm x stage_height_cm, local
    # origin at its own top-left corner) sits inside the terrain glTF's own
    # world space — purely a 3D-view/editing placement, unrelated to
    # transform_origin_*/invert_*/swap_xy above (those shape the PSN output,
    # not the on-screen mapping). A terrain survey has no reason to share an
    # origin or orientation with the stage rectangle (observed 2026-07-28:
    # defaults leave them stacked at the world origin, which is wrong for
    # any real venue). Defaults (0,0,0) keep prior behaviour unchanged.
    stage_map_origin_x_m: float = 0.0
    stage_map_origin_z_m: float = 0.0
    stage_map_rotation_deg: float = 0.0
    # Rotation du MODÈLE 3D (terrain glTF) autour de son origine, en degrés
    # — indépendante de la rotation de la zone de jeu (mission 2026-07-29).
    terrain_rotation_deg: float = 0.0
    # Mission "refonte AE/Reaper" (2026-08-01) : vitesse (cm/s) utilisée pour
    # calculer la durée des blocs en "durée automatique" (Cue.auto_duration)
    # à partir de la distance parcourue. Réglage PROJET, pas une constante
    # (demandé explicitement) — 220 cm/s = 2,2 m/s par défaut (jogging léger,
    # cf. recherche vitesses humaines : marche ~1,3 m/s, jogging ~2,2 m/s).
    reference_speed_cms: float = 220.0

    # Diamètre du marqueur d'acteur dans la scène (cm) — réglage PROJET
    # (menu Réglages), pas une constante : la taille "correcte" dépend du
    # fixture réellement porté (Florian : "la taille des épaules d'une
    # personne, ou la longueur d'un tube Astera" — confirmé à 60 cm par
    # défaut). Purement visuel/éditeur : n'affecte jamais la résolution de
    # lecture, aucun miroir Rust nécessaire.
    actor_diameter_cm: float = 60.0

    # Réglages d'affichage du terrain (demande 2026-08-06, "tous les
    # réglages du terrain doivent être dans la sauvegarde") : vivaient en
    # état React et repartaient à zéro à chaque lancement. Purement
    # visuels/éditeur — aucun miroir Rust.
    grid_opacity: float = 0.5
    grid_shade: float = 0.15  # 0 = noir, 1 = blanc
    snap_to_grid: bool = False

    # Offset GLOBAL de sortie (demande 2026-08-06, "mon Depence je dois
    # descendre les astera de 12 m") : purement ADDITIF, indépendant des
    # presets d'orientation, appliqué en TOUT dernier dans OutputTransform
    # (après centre/placement/inversions/swap) — un recalage du monde reçu
    # par la prévisu, rien d'autre. En mètres ; z = hauteur. Stocké dans la
    # sauvegarde comme le reste du repère de sortie.
    output_offset_x_m: float = 0.0
    output_offset_y_m: float = 0.0
    output_offset_z_m: float = 0.0
    output_rotation_deg: float = 0.0
    # Offsets d'ORIENTATION globaux (2026-08-06, "dans le GLOBAL met toutes
    # les rotations partout disponibles, que tout soit une chaîne qui
    # s'additionne") : degrés AJOUTÉS aux axes ori_x/ori_y/ori_z ÉMIS,
    # tels qu'affichés dans le moniteur — en tout dernier de la chaîne
    # lacet résolu -> preset (rX/rZ + offset rY) -> offsets globaux.
    output_ori_x_deg: float = 0.0
    output_ori_y_deg: float = 0.0
    output_ori_z_deg: float = 0.0

    # "Timecode In" (2026-08-06) : le transport suit un timecode Art-Net
    # entrant (UDP 6454) au lieu de l'horloge interne — voir
    # core/timecode.py (parsing aligné sur Super Timecode Converter, qui
    # sert de routeur LTC/MTC -> Art-Net devant Lumitrack). Le décalage
    # timecode_offset_ms existant est soustrait du TC reçu.
    timecode_chase_enabled: bool = False
    # Carte réseau d'écoute du timecode Art-Net — "0.0.0.0" = toutes les
    # interfaces (même convention que psn_iface_ip côté sortie).
    timecode_iface_ip: str = "0.0.0.0"

    # ---------- helpers ----------

    def ensure_backstage(self):
        """Zone backstage par défaut (au bord jardin de la zone de jeu) si
        le projet n'en a aucune, et attache chaque acteur orphelin à la
        première zone. Idempotent — appelé au chargement et à la création."""
        if not self.backstage_zones:
            self.backstage_zones.append({
                "id": "backstage-1", "name": "Backstage",
                "xCm": -500.0, "yCm": 0.0,
                "widthCm": 400.0,
                "heightCm": min(1200.0, float(self.stage_height_cm)),
            })
        zone_ids = {z["id"] for z in self.backstage_zones}
        first = self.backstage_zones[0]["id"]
        for pt in self.points:
            if pt.home_zone_id not in zone_ids:
                pt.home_zone_id = first

    def sort_cues(self):
        self.cues.sort(key=lambda c: c.start_ms)

    def point_by_id(self, pid: str) -> Optional[Point]:
        for p in self.points:
            if p.id == pid:
                return p
        return None

    def delete_point(self, point_id: str):
        """Retire un acteur — jamais fait avant cette mission (le roster ne
        savait qu'ajouter). Ses activations dans TOUS les cues partent
        aussi, sinon des activations fantômes traînent indéfiniment."""
        self.points = [p for p in self.points if p.id != point_id]
        for cue in self.cues:
            cue.activations.pop(point_id, None)

    def reorder_points(self, point_ids: list):
        """Réordonne `points` selon `point_ids` (glisser-déposer/réassignation
        de sous-groupe dans le roster). Les ids inconnus sont ignorés ; les
        points absents de la liste gardent leur ordre relatif, à la fin."""
        by_id = {p.id: p for p in self.points}
        ordered = [by_id[pid] for pid in point_ids if pid in by_id]
        seen = {p.id for p in ordered}
        remaining = [p for p in self.points if p.id not in seen]
        self.points = ordered + remaining

    def prune_roster_groups(self):
        """Après un set_roster_groups qui supprime un groupe : les acteurs
        qui y étaient rattachés redeviennent simplement "sans groupe"
        (jamais orphelins d'un id de groupe qui n'existe plus)."""
        valid_ids = {g["id"] for g in self.roster_groups}
        for pt in self.points:
            if pt.roster_group_id not in valid_ids:
                pt.roster_group_id = None

    def prune_mount_presets(self):
        """Après un set_fixture_mount_presets qui supprime un preset : les
        activations qui l'utilisaient repassent à "ne rien changer" (None),
        jamais orphelines d'un id de preset qui n'existe plus. "" ("aucun
        preset", efface explicitement) reste valide par construction."""
        valid_ids = {p["id"] for p in self.fixture_mount_presets}
        for cue in self.cues:
            if cue.default_mount_preset_id and cue.default_mount_preset_id not in valid_ids:
                cue.default_mount_preset_id = None
            for act in cue.activations.values():
                if act.mount_preset_id and act.mount_preset_id not in valid_ids:
                    act.mount_preset_id = None

    def cue_by_id(self, cid: str) -> Optional[Cue]:
        for c in self.cues:
            if c.id == cid:
                return c
        return None

    @property
    def total_cue_ms(self) -> float:
        ends = [c.start_ms + c.duration_ms for c in self.cues]
        ends += [c.activation_end_ms() for c in self.cues]
        return max(ends, default=0.0)

    @property
    def duration_ms(self) -> float:
        if self.audio_duration_s:
            return max(self.audio_duration_s * 1000.0, self.total_cue_ms)
        return max(self.total_cue_ms, 1000.0)

    def next_start_ms(self, gap_ms: float = 0.0) -> float:
        return self.total_cue_ms + gap_ms

    # ---------- group / relative editing helper (§12.1, §13.1.1) ----------

    def apply_group_transform(self, cue: Cue, point_ids, *,
                               pivot=(0.0, 0.0), translate=(0.0, 0.0),
                               rotate_deg: float = 0.0,
                               fade_ms: float = 1000.0, easing: str = "linear",
                               resolve_origin_ms: Optional[float] = None):
        """Bake a relative translation/rotation applied to `point_ids` around
        `pivot` (cm) into absolute per-point Activations on `cue`. Each point
        gets its own arc (different radius from the pivot) rather than a
        rigid shared displacement — the model only ever stores the result.
        """
        from .timeline import resolve_positions  # local import: avoid cycle

        if resolve_origin_ms is None:
            resolve_origin_ms = cue.start_ms
        origins = resolve_positions(self, resolve_origin_ms)

        px, py = pivot
        angle = math.radians(rotate_deg)
        cos_a, sin_a = math.cos(angle), math.sin(angle)
        dx, dy = translate

        for pid in point_ids:
            origin = origins.get(pid)
            if origin is None:
                continue
            ox, oy = origin.x_cm - px, origin.y_cm - py
            rx = ox * cos_a - oy * sin_a
            ry = ox * sin_a + oy * cos_a
            target_x = px + rx + dx
            target_y = py + ry + dy

            act = cue.activations.get(pid) or Activation(fade_ms=fade_ms, easing=easing)
            act.target_x_cm = target_x
            act.target_y_cm = target_y
            act.fade_ms = fade_ms
            act.easing = easing
            cue.activations[pid] = act

    # ---------- native format ----------

    def to_dict(self) -> dict:
        return {
            "format": PROJECT_FORMAT,
            "version": PROJECT_VERSION,
            "appVersion": APP_VERSION,
            "name": self.name,
            "stageWidthCm": self.stage_width_cm,
            "stageHeightCm": self.stage_height_cm,
            "gridSizeCm": self.grid_size_cm,
            "floorImagePath": self.floor_image_path,
            "terrainGltfPath": self.terrain_gltf_path,
            "audioPath": self.audio_path,
            "audioDurationS": self.audio_duration_s,
            "bpm": self.bpm,
            "timecodeOffsetMs": self.timecode_offset_ms,
            "outputOffsetXM": self.output_offset_x_m,
            "outputOffsetYM": self.output_offset_y_m,
            "outputOffsetZM": self.output_offset_z_m,
            "outputRotationDeg": self.output_rotation_deg,
            "outputOriXDeg": self.output_ori_x_deg,
            "outputOriYDeg": self.output_ori_y_deg,
            "outputOriZDeg": self.output_ori_z_deg,
            "timecodeChaseEnabled": self.timecode_chase_enabled,
            "timecodeIfaceIp": self.timecode_iface_ip,
            "psnSystemName": self.psn_system_name,
            "psnMcastIp": self.psn_mcast_ip,
            "psnPort": self.psn_port,
            "transformOriginXCm": self.transform_origin_x_cm,
            "transformOriginYCm": self.transform_origin_y_cm,
            "transformInvertX": self.transform_invert_x,
            "transformInvertY": self.transform_invert_y,
            "transformSwapXy": self.transform_swap_xy,
            "transformUpAxis": self.transform_up_axis,
            "psnIfaceIp": self.psn_iface_ip,
            "psnRateHz": self.psn_rate_hz,
            "stageMapOriginXM": self.stage_map_origin_x_m,
            "stageMapOriginZM": self.stage_map_origin_z_m,
            "stageMapRotationDeg": self.stage_map_rotation_deg,
            "terrainRotationDeg": self.terrain_rotation_deg,
            "referenceSpeedCms": self.reference_speed_cms,
            "actorDiameterCm": self.actor_diameter_cm,
            "gridOpacity": self.grid_opacity,
            "gridShade": self.grid_shade,
            "snapToGrid": self.snap_to_grid,
            "backstageZones": self.backstage_zones,
            "rosterGroups": self.roster_groups,
            "fixtureMountPresets": self.fixture_mount_presets,
            "points": [p.to_dict() for p in self.points],
            "cues": [
                {
                    "id": c.id, "name": c.name, "color": c.color,
                    "startMs": c.start_ms, "durationMs": c.duration_ms,
                    "lane": c.lane, "autoDuration": c.auto_duration,
                    "defaultTravelOrientationMode": c.default_travel_orientation_mode,
                    "defaultTravelFixedYawDeg": c.default_travel_fixed_yaw_deg,
                    "defaultTravelFocusPointId": c.default_travel_focus_point_id,
                    "defaultArrivalOrientationMode": c.default_arrival_orientation_mode,
                    "defaultArrivalFixedYawDeg": c.default_arrival_fixed_yaw_deg,
                    "defaultArrivalFocusPointId": c.default_arrival_focus_point_id,
                    "defaultMountPresetId": c.default_mount_preset_id,
                    "defaultYawTurnMs": c.default_yaw_turn_ms,
                    "activations": {
                        pid: a.to_dict() for pid, a in c.activations.items()
                    },
                }
                for c in self.cues
            ],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Project":
        if d.get("format") != PROJECT_FORMAT:
            raise ValueError(f"Not a {PROJECT_FORMAT} project file")
        # Garde anti-rétrogradation (2026-08-06) : un fichier écrit par une
        # version PLUS RÉCENTE de l'app peut contenir des données que cette
        # version ne sait pas interpréter — refus net plutôt qu'une
        # ouverture silencieusement fausse (et une re-sauvegarde qui
        # perdrait les champs inconnus).
        if int(d.get("version", 1)) > PROJECT_VERSION:
            written_by = d.get("appVersion", "?")
            raise ValueError(
                f"Ce projet a été sauvegardé par Lumitrack {written_by} "
                f"(format v{int(d['version'])}) — cette version de l'app ne lit "
                f"que le format v{PROJECT_VERSION} au plus. Mettez à jour Lumitrack.")
        if int(d.get("version", 1)) < 2:
            raise ValueError(
                "This project uses the v1 Formation model and can't be "
                "loaded by this version of Lumitrack (no migration path).")
        proj = cls(
            name=d.get("name", "Untitled"),
            stage_width_cm=float(d.get("stageWidthCm", 5000)),
            stage_height_cm=float(d.get("stageHeightCm", 3000)),
            grid_size_cm=float(d.get("gridSizeCm", 50)),
            floor_image_path=d.get("floorImagePath"),
            terrain_gltf_path=d.get("terrainGltfPath"),
            audio_path=d.get("audioPath"),
            audio_duration_s=d.get("audioDurationS"),
            bpm=d.get("bpm"),
            timecode_offset_ms=float(d.get("timecodeOffsetMs", 0.0)),
            output_offset_x_m=float(d.get("outputOffsetXM", 0.0)),
            output_offset_y_m=float(d.get("outputOffsetYM", 0.0)),
            output_offset_z_m=float(d.get("outputOffsetZM", 0.0)),
            output_rotation_deg=float(d.get("outputRotationDeg", 0.0)),
            output_ori_x_deg=float(d.get("outputOriXDeg", 0.0)),
            output_ori_y_deg=float(d.get("outputOriYDeg", 0.0)),
            output_ori_z_deg=float(d.get("outputOriZDeg", 0.0)),
            timecode_chase_enabled=bool(d.get("timecodeChaseEnabled", False)),
            timecode_iface_ip=d.get("timecodeIfaceIp", "0.0.0.0"),
            psn_system_name=d.get("psnSystemName", "Lumitrack"),
            psn_mcast_ip=d.get("psnMcastIp", "236.10.10.10"),
            psn_port=int(d.get("psnPort", 56565)),
            transform_origin_x_cm=float(d.get("transformOriginXCm", 0.0)),
            transform_origin_y_cm=float(d.get("transformOriginYCm", 0.0)),
            transform_invert_x=bool(d.get("transformInvertX", False)),
            transform_invert_y=bool(d.get("transformInvertY", False)),
            transform_swap_xy=bool(d.get("transformSwapXy", False)),
            transform_up_axis=d.get("transformUpAxis", "y"),
            psn_iface_ip=d.get("psnIfaceIp", "0.0.0.0"),
            psn_rate_hz=int(d.get("psnRateHz", 30)),
            stage_map_origin_x_m=float(d.get("stageMapOriginXM", 0.0)),
            stage_map_origin_z_m=float(d.get("stageMapOriginZM", 0.0)),
            stage_map_rotation_deg=float(d.get("stageMapRotationDeg", 0.0)),
            terrain_rotation_deg=float(d.get("terrainRotationDeg", 0.0)),
            reference_speed_cms=float(d.get("referenceSpeedCms", 220.0)),
            actor_diameter_cm=float(d.get("actorDiameterCm", 60.0)),
            grid_opacity=float(d.get("gridOpacity", 0.5)),
            grid_shade=float(d.get("gridShade", 0.15)),
            snap_to_grid=bool(d.get("snapToGrid", False)),
        )
        proj.backstage_zones = list(d.get("backstageZones") or [])
        proj.roster_groups = list(d.get("rosterGroups") or [])
        proj.fixture_mount_presets = list(d.get("fixtureMountPresets") or [])
        proj.points = [Point.from_dict(p) for p in d.get("points", [])]

        # Migration "modes d'orientation" (2026-08-04) : avant le split
        # trajet/arrivée, une activation stockait orientationMode (manual/
        # path/focus) + targetYawDeg + focusXCm/focusYCm directement.
        # Détectée par l'absence de la clé "travelOrientationMode". "focus"
        # doit en plus faire apparaître un vrai Point(is_focus_point=True)
        # par paire (focusXCm, focusYCm) DISTINCTE rencontrée dans tout le
        # projet (dédupliquées), avec une activation figée dans un cue
        # synthétique à t=0 pour lui donner une position réelle (règle
        # "première apparition" déjà existante côté résolution). Effet
        # visible à signaler à l'utilisateur : d'anciens projets en mode
        # focus verront de nouveaux points apparaître dans le roster.
        focus_point_ids: dict = {}

        def migrated_focus_point_id(fx: float, fy: float) -> str:
            key = (round(fx, 3), round(fy, 3))
            pid = focus_point_ids.get(key)
            if pid is not None:
                return pid
            pid = str(uuid.uuid4())
            letter = chr(ord('A') + len(focus_point_ids)) if len(focus_point_ids) < 26 \
                else str(len(focus_point_ids))
            proj.points.append(Point(id=pid, name=f"Focus {letter}", is_focus_point=True))
            proj.cues.append(Cue(
                id=str(uuid.uuid4()), name=f"Focus {letter} (position)",
                start_ms=0.0, duration_ms=0.0, color="#D8D8E2",
                activations={pid: Activation(
                    target_x_cm=fx, target_y_cm=fy, fade_ms=0.0,
                    orientation_overridden=True,
                )},
            ))
            focus_point_ids[key] = pid
            return pid

        def migrate_legacy_activation(a: dict) -> dict:
            a = dict(a)
            old_mode = a.get("orientationMode", "manual")
            a["orientationOverridden"] = True
            a["arrivalOrientationMode"] = "hold"
            if old_mode == "path":
                a["travelOrientationMode"] = "path"
            elif old_mode == "focus":
                fx, fy = a.get("focusXCm"), a.get("focusYCm")
                if fx is not None and fy is not None:
                    a["travelOrientationMode"] = "focus"
                    a["travelFocusPointId"] = migrated_focus_point_id(float(fx), float(fy))
                else:
                    a["travelOrientationMode"] = "fixed"
                    a["travelFixedYawDeg"] = 0.0
            else:  # "manual" (or unknown) -> the new instantaneous "fixed"
                a["travelOrientationMode"] = "fixed"
                a["travelFixedYawDeg"] = a.get("targetYawDeg") or 0.0
            return a

        for c in d.get("cues", []):
            activations = {
                pid: Activation.from_dict(
                    a if "travelOrientationMode" in a else migrate_legacy_activation(a))
                for pid, a in c.get("activations", {}).items()
            }
            proj.cues.append(Cue(
                id=c["id"], name=c.get("name", ""),
                start_ms=float(c.get("startMs", 0)),
                duration_ms=float(c.get("durationMs", 0)),
                activations=activations,
                color=c.get("color", "#4F6DF5"),
                lane=int(c["lane"]) if c.get("lane") is not None else -1,
                auto_duration=bool(c.get("autoDuration", False)),
                default_travel_orientation_mode=c.get("defaultTravelOrientationMode"),
                default_travel_fixed_yaw_deg=c.get("defaultTravelFixedYawDeg"),
                default_travel_focus_point_id=c.get("defaultTravelFocusPointId"),
                default_arrival_orientation_mode=c.get("defaultArrivalOrientationMode"),
                default_arrival_fixed_yaw_deg=c.get("defaultArrivalFixedYawDeg"),
                default_arrival_focus_point_id=c.get("defaultArrivalFocusPointId"),
                default_mount_preset_id=c.get("defaultMountPresetId"),
                default_yaw_turn_ms=c.get("defaultYawTurnMs"),
            ))
        proj.ensure_backstage()
        proj.sort_cues()
        # Migration multi-pistes : les projets d'avant "lane" empilaient les
        # blocs automatiquement (glouton) — on rejoue cet empaquetage UNE
        # fois pour que rien ne se chevauche visuellement au chargement.
        if any(c.lane < 0 for c in proj.cues):
            lane_ends: list = []
            for c in proj.cues:  # déjà triés par start_ms
                if c.lane >= 0:
                    continue
                for i, end in enumerate(lane_ends):
                    if end <= c.start_ms:
                        c.lane = i
                        lane_ends[i] = c.start_ms + c.duration_ms
                        break
                else:
                    c.lane = len(lane_ends)
                    lane_ends.append(c.start_ms + c.duration_ms)
        return proj

    def save(self, path: str):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(self.to_dict(), fh, indent=2, ensure_ascii=False)

    @classmethod
    def load(cls, path: str) -> "Project":
        with open(path, encoding="utf-8") as fh:
            return cls.from_dict(json.load(fh))


# ---------------------------------------------------------------- .stancz --

def import_stancz(path: str, media_dir: Optional[str] = None) -> Project:
    """Import a Stancz bundle (.stancz = zip with manifest.json + project.json
    + audio/) as an option initial import (CONCEPTION.md §1, no longer the
    design reference, see §12/§13). Positions are cm, origin top-left.

    Stancz's sequential/cumulative formations map 1:1 onto non-overlapping
    Cues: formation N's `duration` becomes both the Cue's displayed width and
    every one of its Activations' fade time, with the same start offset as
    the old cumulative segment boundary — so imported playback is identical
    to the v0.1 behaviour, just expressed in the new model.
    """
    if media_dir is None:
        media_dir = tempfile.mkdtemp(prefix="lumitrack_")
    os.makedirs(media_dir, exist_ok=True)

    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        if "project.json" not in names:
            raise ValueError("No project.json inside the .stancz archive")
        raw = json.loads(zf.read("project.json"))

        proj = Project(
            name=raw.get("name", "Imported"),
            stage_width_cm=float(raw.get("stageWidth", 5000)),
            stage_height_cm=float(raw.get("stageHeight", 3000)),
            grid_size_cm=float(raw.get("gridSize", 50)),
        )

        for d in raw.get("dancers", []):
            proj.points.append(Point(
                id=d["id"],
                name=d.get("name", ""),
                number=d.get("number"),
                color=d.get("color", "#4F6DF5"),
            ))

        formations = sorted(raw.get("formations", []), key=lambda f: f.get("order", 0))
        cursor = 0.0
        for f in formations:
            duration_ms = float(f.get("duration", 0.0))
            easing = f.get("easing", "linear")
            activations = {}
            for p in f.get("positions", []):
                activations[p["dancerId"]] = Activation(
                    target_x_cm=float(p["x"]), target_y_cm=float(p["y"]),
                    fade_ms=duration_ms, easing=easing,
                )
            proj.cues.append(Cue(
                id=f["id"], name=f.get("name", ""),
                start_ms=cursor, duration_ms=duration_ms,
                activations=activations,
            ))
            cursor += duration_ms
        proj.sort_cues()

        audio = raw.get("audioTrack") or {}
        proj.bpm = audio.get("bpm")
        proj.audio_duration_s = audio.get("duration")
        file_url = audio.get("fileUrl")
        if file_url:
            for name in names:
                if name == file_url or name.endswith(file_url):
                    out = os.path.join(media_dir, os.path.basename(name))
                    with open(out, "wb") as fh:
                        fh.write(zf.read(name))
                    proj.audio_path = out
                    break

    return proj


# ------------------------------------------------------------ .bundle -----
#
# Format revu le 2026-08-06 (demande Florian : "une archive propriétaire
# basée sur du zip standard pour envoyer les fichiers facilement via
# Gmail") : UN SEUL FICHIER .lumitrack = une archive ZIP standard :
#
#   MonShow.lumitrack  (zip)
#   |-- project.json             état courant (Project.to_dict())
#   |-- media/<sha256>.<ext>     dépendances (audio/3D/image) dédupliquées
#   |                            par hash de contenu
#   `-- archive/NAME_YYYY-MM-DD_HH-MM-SS-µs.json
#                                copie de l'état PRÉCÉDENT à chaque
#                                sauvegarde, purgée au-delà de
#                                ARCHIVE_MAX_VERSIONS (plus anciennes
#                                d'abord)
#
# Le fichier n'est jamais écrasé sans que l'ancien état soit d'abord
# archivé DANS le zip : aucune sauvegarde n'est jamais perdue, et tout
# voyage dans un unique fichier joignable à un mail. À l'ouverture, les
# médias sont extraits vers un cache local (LOCALAPPDATA/Lumitrack/
# media-cache, noms = hash de contenu donc idempotent) pour que le
# frontend puisse les lire par chemin de fichier ordinaire.
#
# Anciens formats, encore LISIBLES (la sauvegarde convertit au zip) :
# - 2026-07-31 -> 2026-08-06 : fichier JSON nu + dossiers media/ et
#   archive/ à côté (le contenu du fichier devient la première entrée
#   d'archive du zip à la conversion) ;
# - avant le 2026-07-31 : le DOSSIER était le paquet (manifest.json +
#   versions/), voir _load_legacy_directory_bundle.

BUNDLE_FILE_EXT = ".lumitrack"
ARCHIVE_MAX_VERSIONS = 50

_PROJECT_ENTRY = "project.json"
_MEDIA_PREFIX = "media/"
_ARCHIVE_PREFIX = "archive/"

_MEDIA_FIELDS = ("floor_image_path", "terrain_gltf_path", "audio_path")
_MEDIA_JSON_KEYS = {
    "floor_image_path": "floorImagePath",
    "terrain_gltf_path": "terrainGltfPath",
    "audio_path": "audioPath",
}


def _sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _media_cache_dir() -> str:
    """Cache local d'extraction des médias (l'app lit audio/terrain/image
    par chemin de fichier ordinaire, pas depuis le zip). Noms = hash de
    contenu : ré-extraire le même média est un no-op, deux projets
    partageant un média partagent l'entrée. Jamais purgé automatiquement —
    supprimable sans risque, il se reconstruit à l'ouverture suivante."""
    base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, "Lumitrack", "media-cache")


def _archive_entry_names(names: list) -> list:
    return sorted(n for n in names if n.startswith(_ARCHIVE_PREFIX) and n != _ARCHIVE_PREFIX)


def list_archive(file_path: str) -> list:
    """-> [{"name", "mtime" (iso8601)}, ...] le plus récent d'abord, pour le
    panneau "Historique des versions" du frontend. Les noms retournés se
    repassent tels quels à load_bundle(archived_name=...)."""
    if not os.path.isfile(file_path):
        return []
    if zipfile.is_zipfile(file_path):
        entries = []
        with zipfile.ZipFile(file_path) as zf:
            for name in _archive_entry_names(zf.namelist()):
                info = zf.getinfo(name)
                mtime = datetime(*info.date_time, tzinfo=timezone.utc)
                entries.append({"name": name[len(_ARCHIVE_PREFIX):],
                                "mtime": mtime.isoformat()})
        # Tri par NOM (l'horodatage y est encodé, zéro-préfixé, donc trie
        # correctement en texte) — le date_time zip n'a qu'une résolution
        # de 2 s, insuffisante pour départager des sauvegardes rapprochées.
        entries.sort(key=lambda e: e["name"], reverse=True)
        return entries
    # Ancien format fichier+dossiers : archive/ à côté du fichier.
    archive_dir = os.path.join(os.path.dirname(file_path) or ".", "archive")
    if not os.path.isdir(archive_dir):
        return []
    entries = []
    for name in os.listdir(archive_dir):
        if not name.endswith(BUNDLE_FILE_EXT):
            continue
        full = os.path.join(archive_dir, name)
        mtime = datetime.fromtimestamp(os.path.getmtime(full), tz=timezone.utc)
        entries.append({"name": name, "mtime": mtime.isoformat()})
    entries.sort(key=lambda e: e["name"], reverse=True)
    return entries


def save_bundle(project: Project, file_path: str) -> str:
    """Écrit `project` dans `file_path` : une archive zip .lumitrack
    autonome (voir l'en-tête de section). Si le fichier existe déjà — zip
    OU ancien format JSON nu — son état courant est d'abord recopié dans
    archive/ à l'intérieur du nouveau zip (purgé à ARCHIVE_MAX_VERSIONS) :
    jamais d'écrasement sans copie. Écriture atomique (fichier temporaire
    puis os.replace) : une coupure en plein milieu ne corrompt pas la
    sauvegarde précédente. Retourne le chemin écrit (= l'argument)."""
    bundle_dir = os.path.dirname(file_path) or "."
    os.makedirs(bundle_dir, exist_ok=True)

    # 1) Récupérer l'existant : entrées média + archives du zip précédent,
    #    et l'état courant précédent à archiver.
    kept_entries: dict = {}     # nom d'entrée zip -> bytes
    previous_current = None
    if os.path.isfile(file_path):
        if zipfile.is_zipfile(file_path):
            with zipfile.ZipFile(file_path) as zf:
                for name in zf.namelist():
                    if name.startswith((_MEDIA_PREFIX, _ARCHIVE_PREFIX)) and not name.endswith("/"):
                        kept_entries[name] = zf.read(name)
                if _PROJECT_ENTRY in zf.namelist():
                    previous_current = zf.read(_PROJECT_ENTRY)
        else:
            # Conversion d'un ancien fichier JSON nu : son contenu devient
            # la première entrée d'archive du zip. Ses médias (dossier
            # media/ à côté) rentrent dans le zip via les chemins absolus
            # déjà réhydratés du projet en mémoire ; les entrées de
            # l'ancien dossier archive/ ne sont PAS migrées (elles restent
            # lisibles sur place tant que le dossier existe).
            with open(file_path, "rb") as fh:
                previous_current = fh.read()

    # 2) Archiver l'état précédent + purge.
    stem = os.path.splitext(os.path.basename(file_path))[0]
    if previous_current is not None:
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S-%f")
        archived_name = f"{_ARCHIVE_PREFIX}{stem}_{timestamp}.json"
        n = 1
        while archived_name in kept_entries:
            n += 1
            archived_name = f"{_ARCHIVE_PREFIX}{stem}_{timestamp}-{n}.json"
        kept_entries[archived_name] = previous_current
        archives = _archive_entry_names(list(kept_entries))
        for name in archives[:max(0, len(archives) - ARCHIVE_MAX_VERSIONS)]:
            del kept_entries[name]

    # 3) Instantané courant, médias dédupliqués par hash de contenu.
    #    LA RÉFÉRENCE EST LE .lumitrack (demande Florian 2026-08-06) : une
    #    fois un média embarqué, la sauvegarde ne dépend plus jamais du
    #    fichier source — s'il a été déplacé/supprimé depuis, on garde
    #    l'entrée du zip précédent au lieu de perdre la référence.
    previous_refs: dict = {}    # json_key -> nom d'entrée du zip précédent
    if previous_current is not None:
        try:
            prev_snapshot = json.loads(previous_current)
            for json_key in _MEDIA_JSON_KEYS.values():
                rel = prev_snapshot.get(json_key)
                if rel and rel.replace(os.sep, "/") in kept_entries:
                    previous_refs[json_key] = rel.replace(os.sep, "/")
        except (ValueError, AttributeError):
            pass  # ancien état illisible : pas de repli possible
    snapshot = project.to_dict()
    media_to_add: dict = {}     # nom d'entrée zip -> chemin source disque
    for field_name in _MEDIA_FIELDS:
        source_path = getattr(project, field_name)
        json_key = _MEDIA_JSON_KEYS[field_name]
        if not source_path:
            snapshot[json_key] = None
            continue
        if not os.path.isfile(source_path):
            # Source disparue : repli sur l'entrée déjà embarquée dans le
            # zip précédent, sinon la référence est réellement perdue.
            snapshot[json_key] = previous_refs.get(json_key)
            continue
        digest = _sha256_of(source_path)
        ext = os.path.splitext(source_path)[1]
        entry_name = f"{_MEDIA_PREFIX}{digest}{ext}"
        if entry_name not in kept_entries:
            media_to_add[entry_name] = source_path
        snapshot[json_key] = entry_name

    # 4) Écriture atomique du nouveau zip.
    tmp_path = file_path + ".tmp"
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(_PROJECT_ENTRY,
                        json.dumps(snapshot, indent=2, ensure_ascii=False))
            for name, data in kept_entries.items():
                zf.writestr(name, data)
            for name, source in media_to_add.items():
                zf.write(source, name)
        os.replace(tmp_path, file_path)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
    return file_path


def _extract_media(zf, snapshot: dict, bundle_dir: str):
    """Réhydrate les clés média de `snapshot` en chemins de fichiers réels :
    extraction vers le cache local si l'entrée est dans le zip, sinon repli
    sur un fichier posé à côté (archives converties de l'ancien format)."""
    names = set(zf.namelist())
    cache_dir = _media_cache_dir()
    for json_key in _MEDIA_JSON_KEYS.values():
        rel = snapshot.get(json_key)
        if not rel:
            continue
        rel_posix = rel.replace(os.sep, "/")
        if rel_posix in names:
            os.makedirs(cache_dir, exist_ok=True)
            dest = os.path.join(cache_dir, os.path.basename(rel_posix))
            if not os.path.isfile(dest):
                with zf.open(rel_posix) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)
            snapshot[json_key] = dest
        else:
            candidate = os.path.join(bundle_dir, rel.replace("/", os.sep))
            snapshot[json_key] = candidate if os.path.isfile(candidate) else None


def _rehydrate_media_paths(snapshot: dict, bundle_dir: str):
    for json_key in _MEDIA_JSON_KEYS.values():
        rel = snapshot.get(json_key)
        if rel:
            snapshot[json_key] = os.path.join(bundle_dir, rel.replace("/", os.sep))


def _load_legacy_directory_bundle(bundle_dir: str) -> Project:
    """Ancien format (avant le 2026-07-31) : le dossier lui-même est le
    paquet. Lecture seule, toujours la dernière version connue de ce
    format — voir le commentaire d'en-tête de cette section."""
    manifest_path = os.path.join(bundle_dir, "manifest.json")
    if not os.path.isfile(manifest_path):
        raise ValueError(f"Not a Lumitrack bundle: {bundle_dir!r} has no manifest.json")
    with open(manifest_path, encoding="utf-8") as fh:
        manifest = json.load(fh)
    if manifest.get("format") != BUNDLE_FORMAT:
        raise ValueError(f"Not a Lumitrack bundle: {bundle_dir!r}")
    version_path = os.path.join(bundle_dir, "versions", "latest.json")
    with open(version_path, encoding="utf-8") as fh:
        snapshot = json.load(fh)
    _rehydrate_media_paths(snapshot, bundle_dir)
    return Project.from_dict(snapshot)


def load_bundle(file_path: str, archived_name: Optional[str] = None) -> Project:
    """Charge un projet depuis un fichier .lumitrack. `archived_name` (un
    nom renvoyé par `list_archive`) charge cette version archivée plutôt
    que l'état courant. Trois formats acceptés : zip (courant), fichier
    JSON nu + dossiers (2026-07-31 -> 2026-08-06), dossier-paquet (avant).
    Seule la SAUVEGARDE convertit — charger ne modifie jamais le fichier."""
    if os.path.isdir(file_path):
        return _load_legacy_directory_bundle(file_path)

    bundle_dir = os.path.dirname(file_path) or "."
    if zipfile.is_zipfile(file_path):
        with zipfile.ZipFile(file_path) as zf:
            entry = (_ARCHIVE_PREFIX + archived_name if archived_name is not None
                     else _PROJECT_ENTRY)
            snapshot = json.loads(zf.read(entry).decode("utf-8"))
            _extract_media(zf, snapshot, bundle_dir)
        return Project.from_dict(snapshot)

    # Ancien format fichier JSON nu (+ media/ et archive/ à côté).
    real_path = (os.path.join(bundle_dir, "archive", archived_name)
                 if archived_name is not None else file_path)
    with open(real_path, encoding="utf-8") as fh:
        snapshot = json.load(fh)
    _rehydrate_media_paths(snapshot, bundle_dir)
    return Project.from_dict(snapshot)
