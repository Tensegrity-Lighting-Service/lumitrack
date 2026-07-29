// Validation croisée : les paquets de l'encodeur Lumitrack (fixture hex,
// identiques octet à octet entre Python et Rust) sont décodés par le SDK
// OFFICIEL VYV (psn-cpp). Si le décodeur officiel retrouve nos trackers,
// positions, orientations et noms, l'encodeur est conforme PSN 2.x.
#include "psn_lib.hpp"
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include <cmath>

static std::vector<unsigned char> from_hex(const std::string& hex) {
    std::vector<unsigned char> out;
    for (size_t i = 0; i + 1 < hex.size(); i += 2)
        out.push_back((unsigned char)strtol(hex.substr(i, 2).c_str(), nullptr, 16));
    return out;
}

int main(int argc, char** argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <packets.txt>\n", argv[0]); return 2; }
    std::ifstream in(argv[1]);
    std::string line;
    psn::psn_decoder decoder;
    int packets = 0, checks = 0;
    // Format de l'entrée : lignes "DATA <hex>" / "INFO <hex>" puis
    // "EXPECT <id> <x> <y> <z> <yaw_rad> <name>" après le lot.
    std::vector<std::string> expects;
    while (std::getline(in, line)) {
        if (line.rfind("DATA ", 0) == 0 || line.rfind("INFO ", 0) == 0) {
            auto bytes = from_hex(line.substr(5));
            decoder.decode((const char*)bytes.data(), bytes.size());
            packets++;
        } else if (line.rfind("EXPECT ", 0) == 0) {
            expects.push_back(line.substr(7));
        }
    }
    const auto& data = decoder.get_data();
    const auto& info = decoder.get_info();
    printf("systeme: '%s' | trackers data: %zu | noms info: %zu\n",
           info.system_name.c_str(), data.trackers.size(), info.tracker_names.size());
    for (const auto& e : expects) {
        std::istringstream ss(e);
        int id; float x, y, z, yaw; std::string name;
        ss >> id >> x >> y >> z >> yaw;
        std::getline(ss, name);
        if (!name.empty() && name[0] == ' ') name.erase(0, 1);
        auto itd = data.trackers.find((uint16_t)id);
        auto iti = info.tracker_names.find(id);
        if (itd == data.trackers.end()) { printf("ECHEC: tracker %d absent (data)\n", id); return 1; }
        if (iti == info.tracker_names.end()) { printf("ECHEC: tracker %d absent (info)\n", id); return 1; }
        const auto& t = itd->second;
        if (std::fabs(t.get_pos().x - x) > 1e-5f || std::fabs(t.get_pos().y - y) > 1e-5f
            || std::fabs(t.get_pos().z - z) > 1e-5f) {
            printf("ECHEC: tracker %d pos (%f,%f,%f) != (%f,%f,%f)\n", id,
                   t.get_pos().x, t.get_pos().y, t.get_pos().z, x, y, z);
            return 1;
        }
        if (std::fabs(t.get_ori().z - yaw) > 1e-5f) {
            printf("ECHEC: tracker %d ori.z %f != %f\n", id, t.get_ori().z, yaw);
            return 1;
        }
        if (iti->second != name) {
            printf("ECHEC: tracker %d nom '%s' != '%s'\n", id, iti->second.c_str(), name.c_str());
            return 1;
        }
        checks++;
    }
    printf("OK: %d paquets decodes par le SDK officiel, %d trackers verifies\n", packets, checks);
    return 0;
}
