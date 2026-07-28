//! Parité octet-à-octet de l'encodeur PSN Rust contre l'encodeur Python
//! (lui-même validé contre pypsn, donc reconnu par grandMA3/Capture). La
//! fixture fige le timestamp — toute divergence d'encodage casse ce test.

use lumitrack_engine::psn::{
    build_data_packet, build_info_packet, split_data_packets, split_info_packets,
    Tracker, PSN_MAX_PACKET_SIZE,
};
use serde_json::Value;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn packets_are_byte_identical_to_python() {
    let doc: Value = serde_json::from_str(include_str!("fixtures/psn_parity.json")).unwrap();
    let ts_us = doc["timestampUs"].as_u64().unwrap();

    for case in doc["cases"].as_array().unwrap() {
        let n = case["n"].as_u64().unwrap();
        let trackers: Vec<Tracker> = case["trackers"].as_array().unwrap().iter().map(|t| Tracker {
            id: t["id"].as_u64().unwrap() as u16,
            name: t["name"].as_str().unwrap().to_string(),
            x_m: t["x"].as_f64().unwrap() as f32,
            y_m: t["y"].as_f64().unwrap() as f32,
            z_m: t["z"].as_f64().unwrap() as f32,
            yaw_rad: t["yaw"].as_f64().unwrap() as f32,
        }).collect();

        let data = build_data_packet(&trackers, ts_us, 7, 2);
        assert_eq!(hex(&data), case["data_hex"].as_str().unwrap(), "n={n}: DATA");

        let info = build_info_packet(&trackers, "Lumitrack ✓", ts_us, 7, 2);
        assert_eq!(hex(&info), case["info_hex"].as_str().unwrap(), "n={n}: INFO");

        let split_data = split_data_packets(&trackers, ts_us, 9, PSN_MAX_PACKET_SIZE);
        let exp: Vec<&str> = case["split_data_hex"].as_array().unwrap()
            .iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(split_data.len(), exp.len(), "n={n}: nb paquets DATA");
        for (got, want) in split_data.iter().zip(&exp) {
            assert_eq!(hex(got), **want, "n={n}: split DATA");
        }

        let split_info = split_info_packets(&trackers, "Lumitrack", ts_us, 9, PSN_MAX_PACKET_SIZE);
        let exp: Vec<&str> = case["split_info_hex"].as_array().unwrap()
            .iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(split_info.len(), exp.len(), "n={n}: nb paquets INFO");
        for (got, want) in split_info.iter().zip(&exp) {
            assert_eq!(hex(got), **want, "n={n}: split INFO");
        }

        let tiny = split_info_packets(&trackers, "s", ts_us, 1, 120);
        let exp: Vec<&str> = case["tiny_split_info_hex"].as_array().unwrap()
            .iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(tiny.len(), exp.len(), "n={n}: nb paquets tiny");
        for (got, want) in tiny.iter().zip(&exp) {
            assert_eq!(hex(got), **want, "n={n}: tiny split INFO");
        }
    }
}
