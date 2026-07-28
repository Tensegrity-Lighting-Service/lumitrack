//! Timecode — port de `core/timecode.py` : parsing/formatage, décodage
//! Art-Net OpTimeCode, décodeur MTC (quarter-frame + full-frame) en logique
//! pure. Les threads d'E/S (socket Art-Net, port MIDI) seront branchés à
//! l'intégration Tauri (N2) — ici, uniquement la logique testable.

pub const ARTNET_PORT: u16 = 6454;
const ARTNET_ID: &[u8; 8] = b"Art-Net\0";
const OP_TIMECODE: u16 = 0x9700;

fn artnet_rate(tc_type: u8) -> f64 {
    match tc_type {
        0 => 24.0,
        1 => 25.0,
        2 => 29.97,
        3 => 30.0,
        _ => 25.0,
    }
}

/// Port de `parse_timecode` : accepte `SS`, `SS.mmm`, `MM:SS`, `HH:MM:SS`
/// (virgule décimale acceptée). Retourne des millisecondes.
pub fn parse_timecode(text: &str) -> Result<f64, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("timecode vide".into());
    }
    let parts: Vec<&str> = text.split(':').collect();
    if parts.len() > 3 {
        return Err(format!("Unrecognised timecode: {text:?}"));
    }
    // Toutes les composantes sauf la dernière : entiers ; la dernière peut
    // porter une décimale (point ou virgule) — même tolérance que la regex
    // Python (\d+ pour heures/minutes, \d+([.,]\d+)? pour les secondes).
    let mut values: Vec<f64> = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        let last = i == parts.len() - 1;
        let normalised = if last { part.replace(',', ".") } else { (*part).to_string() };
        if normalised.is_empty()
            || !normalised.chars().all(|c| c.is_ascii_digit() || (last && c == '.'))
            || normalised.matches('.').count() > 1
        {
            return Err(format!("Unrecognised timecode: {text:?}"));
        }
        values.push(normalised.parse::<f64>().map_err(|e| e.to_string())?);
    }
    let seconds = *values.last().unwrap();
    let minutes = if values.len() >= 2 { values[values.len() - 2] } else { 0.0 };
    let hours = if values.len() >= 3 { values[values.len() - 3] } else { 0.0 };
    Ok((hours * 3600.0 + minutes * 60.0 + seconds) * 1000.0)
}

/// Port de `format_timecode` : `HH:MM:SS.mmm`, ou `HH:MM:SS:FF` avec fps.
pub fn format_timecode(ms: f64, fps: Option<f64>) -> String {
    let ms = ms.max(0.0);
    let total_s = ms / 1000.0;
    let h = (total_s / 3600.0).floor() as u64;
    let m = ((total_s % 3600.0) / 60.0).floor() as u64;
    match fps {
        Some(fps) if fps > 0.0 => {
            let s = (total_s % 60.0).floor() as u64;
            let frames = ((total_s - total_s.floor()) * fps).floor() as u64;
            format!("{h:02}:{m:02}:{s:02}:{frames:02}")
        }
        _ => format!("{h:02}:{m:02}:{:06.3}", total_s % 60.0),
    }
}

pub fn hmsf_to_ms(h: u32, m: u32, s: u32, f: u32, fps: f64) -> f64 {
    let frames_s = if fps > 0.0 { f as f64 / fps } else { 0.0 };
    ((h as f64) * 3600.0 + (m as f64) * 60.0 + (s as f64) + frames_s) * 1000.0
}

/// Port de `parse_artnet_timecode` : `(millisecondes, fps)` pour un paquet
/// Art-Net OpTimeCode, sinon None.
pub fn parse_artnet_timecode(data: &[u8]) -> Option<(f64, f64)> {
    if data.len() < 19 || &data[..8] != ARTNET_ID {
        return None;
    }
    let opcode = u16::from_le_bytes([data[8], data[9]]);
    if opcode != OP_TIMECODE {
        return None;
    }
    let (frames, seconds, minutes, hours, tc_type) =
        (data[14], data[15], data[16], data[17], data[18]);
    let fps = artnet_rate(tc_type);
    Some((hmsf_to_ms(hours as u32, minutes as u32, seconds as u32, frames as u32, fps), fps))
}

/// Décodeur MTC pur — port de la logique de `MidiTimecodeReceiver` sans le
/// port MIDI. Nourrir les messages, récolter `Some((ms, fps))` quand une
/// position complète est disponible.
#[derive(Debug, Default)]
pub struct MtcDecoder {
    nibbles: [u8; 8],
}

impl MtcDecoder {
    fn rate(code: u8) -> f64 {
        match code & 0x03 {
            0 => 24.0,
            1 => 25.0,
            2 => 29.97,
            _ => 30.0,
        }
    }

    /// Quarter-frame (0xF1) : `frame_type` 0..7, `frame_value` nibble. La
    /// position n'est émise qu'à l'arrivée du nibble 7, comme en Python.
    pub fn quarter_frame(&mut self, frame_type: u8, frame_value: u8) -> Option<(f64, f64)> {
        if frame_type > 7 {
            return None;
        }
        self.nibbles[frame_type as usize] = frame_value & 0x0F;
        if frame_type != 7 {
            return None;
        }
        let n = &self.nibbles;
        let frames = (n[0] | (n[1] << 4)) as u32;
        let seconds = (n[2] | (n[3] << 4)) as u32;
        let minutes = (n[4] | (n[5] << 4)) as u32;
        let hours_raw = n[6] | (n[7] << 4);
        let hours = (hours_raw & 0x1F) as u32;
        let fps = Self::rate((hours_raw >> 5) & 0x03);
        Some((hmsf_to_ms(hours, minutes, seconds, frames, fps), fps))
    }

    /// Full-frame sysex : données SANS F0/F7 — `7F <dev> 01 01 hh mm ss ff`.
    pub fn full_frame(&mut self, data: &[u8]) -> Option<(f64, f64)> {
        if data.len() < 8 || data[0] != 0x7F || data[2] != 0x01 || data[3] != 0x01 {
            return None;
        }
        let (hours_raw, minutes, seconds, frames) = (data[4], data[5], data[6], data[7]);
        let hours = (hours_raw & 0x1F) as u32;
        let fps = Self::rate((hours_raw >> 5) & 0x03);
        Some((hmsf_to_ms(hours, minutes as u32, seconds as u32, frames as u32, fps), fps))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Oracle : test_core — formats acceptés et refusés par parse_timecode.
    #[test]
    fn parse_accepts_python_formats() {
        assert_eq!(parse_timecode("45").unwrap(), 45_000.0);
        assert_eq!(parse_timecode("45.5").unwrap(), 45_500.0);
        assert_eq!(parse_timecode("45,5").unwrap(), 45_500.0);
        assert_eq!(parse_timecode("2:30").unwrap(), 150_000.0);
        assert_eq!(parse_timecode("1:02:03.5").unwrap(), 3_723_500.0);
        assert_eq!(parse_timecode("  10  ").unwrap(), 10_000.0);
        assert!(parse_timecode("").is_err());
        assert!(parse_timecode("abc").is_err());
        assert!(parse_timecode("1:2:3:4").is_err());
        assert!(parse_timecode("1:a:3").is_err());
    }

    #[test]
    fn format_matches_python() {
        assert_eq!(format_timecode(3_723_500.0, None), "01:02:03.500");
        assert_eq!(format_timecode(3_723_500.0, Some(25.0)), "01:02:03:12");
        assert_eq!(format_timecode(-5.0, None), "00:00:00.000");
    }

    /// Oracle : test_core — décodage d'un paquet Art-Net TC synthétique.
    #[test]
    fn artnet_timecode_decodes() {
        let mut pkt = Vec::new();
        pkt.extend_from_slice(b"Art-Net\0");
        pkt.extend_from_slice(&0x9700u16.to_le_bytes()); // opcode LE
        pkt.extend_from_slice(&[0, 14]); // protver BE
        pkt.extend_from_slice(&[0, 0]); // filler
        pkt.extend_from_slice(&[10, 3, 2, 1, 1]); // f=10 s=3 m=2 h=1 type=25fps
        let (ms, fps) = parse_artnet_timecode(&pkt).unwrap();
        assert_eq!(fps, 25.0);
        assert!((ms - hmsf_to_ms(1, 2, 3, 10, 25.0)).abs() < 1e-9);
        assert!(parse_artnet_timecode(b"nope").is_none());
        pkt[9] = 0x00; // mauvais opcode (octet fort du LE)
        assert!(parse_artnet_timecode(&pkt).is_none());
    }

    #[test]
    fn mtc_quarter_frames_emit_on_last_nibble() {
        let mut d = MtcDecoder::default();
        // 01:02:03:10 à 25 fps → hours_raw = 1 | (rate 1 << 5) = 0x21.
        let vals = [10 & 0xF, 10 >> 4, 3 & 0xF, 3 >> 4, 2 & 0xF, 2 >> 4, 0x1, 0x2];
        for (i, v) in vals.iter().enumerate().take(7) {
            assert!(d.quarter_frame(i as u8, *v).is_none());
        }
        let (ms, fps) = d.quarter_frame(7, vals[7]).unwrap();
        assert_eq!(fps, 25.0);
        assert!((ms - hmsf_to_ms(1, 2, 3, 10, 25.0)).abs() < 1e-9);
    }

    #[test]
    fn mtc_full_frame_decodes() {
        let mut d = MtcDecoder::default();
        // 7F dev 01 01 hh mm ss ff ; hh = heures | rate<<5
        let (ms, fps) = d.full_frame(&[0x7F, 0x00, 0x01, 0x01, 0x21, 2, 3, 10]).unwrap();
        assert_eq!(fps, 25.0);
        assert!((ms - hmsf_to_ms(1, 2, 3, 10, 25.0)).abs() < 1e-9);
        assert!(d.full_frame(&[0x7F, 0x00, 0x02, 0x01, 0, 0, 0, 0]).is_none());
    }
}
