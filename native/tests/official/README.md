# Validation contre le SDK officiel PSN (VYV)

L'encodeur Lumitrack (Python + Rust, byte-identiques) est validé contre le
décodeur de référence [psn-cpp](https://github.com/vyv/psn-cpp) (MIT, VYV
Corporation — les consoles/serveurs média dérivent de cette implémentation).

Résultat du 2026-07-29 : 7 paquets (DATA+INFO, découpage MTU du cas 92
trackers, noms Unicode), 92 trackers vérifiés — positions/orientations à
1e-5, noms et nom de système exacts. Constantes de chunks et version de
header (2.0) identiques à `psn_defs.hpp`.

Rejouer :

    git clone --depth 1 https://github.com/vyv/psn-cpp.git
    python3 gen_packets.py          # écrit psn_packets.txt depuis la fixture
    g++ -std=c++17 -I psn-cpp/include psn_validate.cpp -o psn_validate
    ./psn_validate psn_packets.txt

Chunks optionnels de la spec 2.03 non émis (conformes en leur absence) :
SPEED (0x0001), STATUS (0x0003), ACCEL (0x0004), TRGTPOS (0x0005),
TIMESTAMP (0x0006). SPEED serait le premier candidat si une console veut
prédire le mouvement entre trames.
