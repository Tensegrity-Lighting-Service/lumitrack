//! Encodeur PSN (PosiStageNet) v2 — port de `core/psn.py`.
//!
//! La disposition binaire est reprise à l'identique (validée côté Python
//! contre le parseur pypsn, lui-même reconnu par grandMA3). Différence
//! d'API : le timestamp du header est un PARAMÈTRE (µs) au lieu d'un appel
//! d'horloge interne — indispensable pour la parité octet-à-octet des
//! fixtures, et plus propre pour le futur appelant (le transport possède
//! déjà l'horloge).

pub const PSN_DEFAULT_MCAST_IP: &str = "236.10.10.10";
pub const PSN_DEFAULT_PORT: u16 = 56565;
pub const PSN_MAX_PACKET_SIZE: usize = 1500 - 28;

const CHUNK_ID_INFO_PACKET: u16 = 0x6756;
const CHUNK_ID_DATA_PACKET: u16 = 0x6755;

const INFO_PACKET_HEADER: u16 = 0x0000;
const INFO_SYSTEM_NAME: u16 = 0x0001;
const INFO_TRACKER_LIST: u16 = 0x0002;
const INFO_TRACKER_NAME: u16 = 0x0000;

const DATA_PACKET_HEADER: u16 = 0x0000;
const DATA_TRACKER_LIST: u16 = 0x0001;
const DATA_TRACKER_POS: u16 = 0x0000;
const DATA_TRACKER_ORI: u16 = 0x0002;

const HAS_SUBCHUNKS_FLAG: u16 = 0x8000;

fn chunk(chunk_id: u16, data: &[u8], has_subchunks: bool) -> Vec<u8> {
    let mut length_field = (data.len() as u16) & 0x7FFF;
    if has_subchunks {
        length_field |= HAS_SUBCHUNKS_FLAG;
    }
    let mut out = Vec::with_capacity(4 + data.len());
    out.extend_from_slice(&chunk_id.to_le_bytes());
    out.extend_from_slice(&length_field.to_le_bytes());
    out.extend_from_slice(data);
    out
}

fn header_bytes(timestamp_us: u64, frame_id: u8, packet_count: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(12);
    out.extend_from_slice(&timestamp_us.to_le_bytes());
    out.push(2); // version high
    out.push(0); // version low
    out.push(frame_id);
    out.push(packet_count);
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct Tracker {
    pub id: u16,
    pub name: String,
    pub x_m: f32,
    pub y_m: f32,
    pub z_m: f32,
    /// Lacet en radians — seul angle porteur de sens pour un projecteur
    /// porté (§12.5) ; envoyé en 3e float du chunk ORI comme en Python.
    pub yaw_rad: f32,
}

pub fn build_data_packet(trackers: &[Tracker], timestamp_us: u64, frame_id: u8, packet_count: u8) -> Vec<u8> {
    let header = chunk(DATA_PACKET_HEADER, &header_bytes(timestamp_us, frame_id, packet_count), false);

    let mut tracker_chunks = Vec::new();
    for t in trackers {
        let mut pos = Vec::with_capacity(12);
        pos.extend_from_slice(&t.x_m.to_le_bytes());
        pos.extend_from_slice(&t.y_m.to_le_bytes());
        pos.extend_from_slice(&t.z_m.to_le_bytes());
        let pos_chunk = chunk(DATA_TRACKER_POS, &pos, false);

        let mut ori = Vec::with_capacity(12);
        ori.extend_from_slice(&0f32.to_le_bytes());
        ori.extend_from_slice(&0f32.to_le_bytes());
        ori.extend_from_slice(&t.yaw_rad.to_le_bytes());
        let ori_chunk = chunk(DATA_TRACKER_ORI, &ori, false);

        let mut body = pos_chunk;
        body.extend_from_slice(&ori_chunk);
        tracker_chunks.extend_from_slice(&chunk(t.id, &body, true));
    }

    let tracker_list = chunk(DATA_TRACKER_LIST, &tracker_chunks, true);
    let mut body = header;
    body.extend_from_slice(&tracker_list);
    chunk(CHUNK_ID_DATA_PACKET, &body, true)
}

pub fn build_info_packet(trackers: &[Tracker], system_name: &str, timestamp_us: u64,
                         frame_id: u8, packet_count: u8) -> Vec<u8> {
    let header = chunk(INFO_PACKET_HEADER, &header_bytes(timestamp_us, frame_id, packet_count), false);
    let name_chunk = chunk(INFO_SYSTEM_NAME, system_name.as_bytes(), false);

    let mut tracker_chunks = Vec::new();
    for t in trackers {
        let name = chunk(INFO_TRACKER_NAME, t.name.as_bytes(), false);
        tracker_chunks.extend_from_slice(&chunk(t.id, &name, true));
    }

    let tracker_list = chunk(INFO_TRACKER_LIST, &tracker_chunks, true);
    let mut body = header;
    body.extend_from_slice(&name_chunk);
    body.extend_from_slice(&tracker_list);
    chunk(CHUNK_ID_INFO_PACKET, &body, true)
}

/// Port de `_split_trackers` : empaquetage glouton sous `max_size` ; un
/// tracker trop gros seul a quand même son propre paquet (jamais perdu).
fn split_trackers<'a, F>(trackers: &'a [Tracker], build: F, max_size: usize) -> Vec<&'a [Tracker]>
where
    F: Fn(&[Tracker]) -> Vec<u8>,
{
    let mut groups: Vec<&[Tracker]> = Vec::new();
    let mut start = 0usize;
    for i in 0..trackers.len() {
        let end = i + 1;
        if build(&trackers[start..end]).len() > max_size {
            // Retire le dernier ; le groupe précédent (s'il existe) est clos.
            if end - 1 > start {
                groups.push(&trackers[start..end - 1]);
            }
            start = i;
        }
    }
    if trackers.len() > start {
        groups.push(&trackers[start..]);
    }
    groups
}

pub fn split_data_packets(trackers: &[Tracker], timestamp_us: u64, frame_id: u8,
                          max_size: usize) -> Vec<Vec<u8>> {
    let groups = split_trackers(trackers, |g| build_data_packet(g, timestamp_us, frame_id, 1), max_size);
    // Python : liste vide de trackers -> AUCUN paquet (rien à envoyer).
    let count = groups.len().max(1) as u8;
    groups.iter().map(|g| build_data_packet(g, timestamp_us, frame_id, count)).collect()
}

pub fn split_info_packets(trackers: &[Tracker], system_name: &str, timestamp_us: u64,
                          frame_id: u8, max_size: usize) -> Vec<Vec<u8>> {
    let groups = split_trackers(trackers, |g| build_info_packet(g, system_name, timestamp_us, frame_id, 1), max_size);
    let count = groups.len().max(1) as u8;
    groups.iter().map(|g| build_info_packet(g, system_name, timestamp_us, frame_id, count)).collect()
}

/// Émetteur UDP multicast — port de `PsnSender` (TTL 8, interface choisie).
pub struct PsnSender {
    sock: std::net::UdpSocket,
    dest: std::net::SocketAddrV4,
    frame_id: u8,
    start: std::time::Instant,
}

impl PsnSender {
    pub fn new(mcast_ip: std::net::Ipv4Addr, port: u16, iface_ip: std::net::Ipv4Addr,
               ttl: u32) -> std::io::Result<Self> {
        // socket2 pour IP_MULTICAST_IF (choix d'interface, exposé dans le
        // panneau Output depuis la v0.1) — std ne l'expose pas.
        let sock = socket2::Socket::new(
            socket2::Domain::IPV4, socket2::Type::DGRAM, Some(socket2::Protocol::UDP))?;
        sock.bind(&std::net::SocketAddr::from(([0, 0, 0, 0], 0)).into())?;
        sock.set_multicast_ttl_v4(ttl)?;
        sock.set_multicast_if_v4(&iface_ip)?;
        Ok(Self {
            sock: sock.into(),
            dest: std::net::SocketAddrV4::new(mcast_ip, port),
            frame_id: 0,
            start: std::time::Instant::now(),
        })
    }

    fn timestamp_us(&self) -> u64 {
        self.start.elapsed().as_micros() as u64
    }

    pub fn send_data(&mut self, trackers: &[Tracker]) -> std::io::Result<()> {
        let ts = self.timestamp_us();
        for packet in split_data_packets(trackers, ts, self.frame_id, PSN_MAX_PACKET_SIZE) {
            self.sock.send_to(&packet, self.dest)?;
        }
        self.frame_id = self.frame_id.wrapping_add(1);
        Ok(())
    }

    pub fn send_info(&mut self, trackers: &[Tracker], system_name: &str) -> std::io::Result<()> {
        let ts = self.timestamp_us();
        for packet in split_info_packets(trackers, system_name, ts, self.frame_id, PSN_MAX_PACKET_SIZE) {
            self.sock.send_to(&packet, self.dest)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trackers(n: usize) -> Vec<Tracker> {
        (0..n).map(|i| Tracker {
            id: i as u16, name: format!("Point {i}"),
            x_m: i as f32, y_m: 2.5, z_m: 0.0, yaw_rad: 0.25 * i as f32,
        }).collect()
    }

    /// Oracle : test_core — aucun tracker perdu au découpage, packet_count
    /// cohérent sur chaque paquet, chaque paquet sous la taille max.
    #[test]
    fn split_loses_no_tracker_and_counts_are_consistent() {
        for n in [1usize, 3, 92, 300] {
            let ts = trackers(n);
            let packets = split_info_packets(&ts, "lumitrack", 0, 0, PSN_MAX_PACKET_SIZE);
            assert!(!packets.is_empty());
            for p in &packets {
                assert!(p.len() <= PSN_MAX_PACKET_SIZE, "n={n}: paquet trop gros");
                // packet_count = octet 12+11 du header interne : chunk racine
                // (4) + chunk header (4) + 12 octets → offset 4+4+11 = 19.
                assert_eq!(p[19] as usize, packets.len(), "n={n}: packet_count");
            }
            let data_packets = split_data_packets(&ts, 0, 0, PSN_MAX_PACKET_SIZE);
            for p in &data_packets {
                assert!(p.len() <= PSN_MAX_PACKET_SIZE);
            }
        }
    }

    #[test]
    fn single_oversized_tracker_still_gets_a_packet() {
        let big = vec![Tracker {
            id: 1, name: "x".repeat(64), x_m: 0.0, y_m: 0.0, z_m: 0.0, yaw_rad: 0.0,
        }];
        let packets = split_info_packets(&big, "s", 0, 0, 32); // max ridicule
        assert_eq!(packets.len(), 1); // jamais perdu, même trop gros
    }
}
