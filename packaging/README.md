# Empaquetage

PyInstaller ne fait **pas** de compilation croisée : le `.exe` se construit
sous Windows, le `.app` sous macOS.

```bash
pip install -r requirements-dev.txt
pyinstaller packaging/stanczpsn.spec
```

Le résultat arrive dans `dist/StanczPSN/` (Windows/Linux) ou
`dist/StanczPSN.app` (macOS).

---

## Windows

- Le premier lancement déclenche une alerte **Pare-feu Windows Defender**.
  Il faut autoriser l'application sur les réseaux **privés** — sinon la
  réception Art-Net timecode ne fonctionnera pas, et le multicast PSN peut
  être bloqué.
- Sans signature de code, SmartScreen affichera « Windows a protégé votre
  ordinateur » → *Informations complémentaires* → *Exécuter quand même*.
  Pour distribuer proprement, il faut un certificat de signature.
- Machine multi-cartes réseau (cas classique en FOH) : renseigner le champ
  **Interface** dans le panneau Output avec l'IP de la carte du réseau
  lumière, sinon les paquets partent sur la mauvaise interface.

## macOS

- Le binaire n'est ni signé ni notarisé : au premier lancement, faire
  **clic droit → Ouvrir**, ou lever la quarantaine :

  ```bash
  xattr -dr com.apple.quarantine dist/StanczPSN.app
  ```

- **macOS 15 (Sequoia) et plus** demandent une autorisation explicite pour
  l'accès au réseau local. Le spec fournit déjà le texte d'explication
  (`NSLocalNetworkUsageDescription`). Si l'autorisation est refusée, PSN et
  Art-Net échouent **silencieusement** :
  Réglages Système → Confidentialité et sécurité → Réseau local.
- Pour un binaire universel Intel + Apple Silicon, mettre
  `target_arch="universal2"` dans le spec — ce qui suppose des dépendances
  elles aussi universelles.

## Linux

Fonctionne, mais aucun paquet n'est fourni. Le dossier `dist/StanczPSN/` est
directement exécutable.

---

## Vérification réseau rapide

Avant de blâmer l'application, vérifier que les paquets sortent vraiment :

```bash
# Windows (avec Wireshark installé) ou macOS/Linux
sudo tcpdump -i any -n udp port 56565
```

Pour le timecode Art-Net entrant :

```bash
sudo tcpdump -i any -n udp port 6454
```

Si `tcpdump` voit les paquets mais pas la prévisu, le problème est côté
réception (interface, TTL multicast, routage) et non côté application.
