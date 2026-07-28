//! Transport (horloge de lecture) — port de `core/engine.py::Transport`.
//! L'horloge est INJECTABLE (fonction -> secondes monotones) : les tests
//! pilotent le temps à la main, et l'intégration branchera Instant.

pub struct Transport {
    playing: bool,
    t_ms: f64,
    started_wall_s: f64,
    started_t_ms: f64,
    duration_ms: f64,
    pub external_sync: bool,
    pub last_external_fps: Option<f64>,
    last_external_wall_s: f64,
    clock: Box<dyn Fn() -> f64 + Send>,
}

impl Transport {
    /// Horloge réelle (monotone, secondes).
    pub fn new() -> Self {
        let start = std::time::Instant::now();
        Self::with_clock(Box::new(move || start.elapsed().as_secs_f64()))
    }

    pub fn with_clock(clock: Box<dyn Fn() -> f64 + Send>) -> Self {
        Self {
            playing: false,
            t_ms: 0.0,
            started_wall_s: 0.0,
            started_t_ms: 0.0,
            duration_ms: 0.0,
            external_sync: false,
            last_external_fps: None,
            last_external_wall_s: 0.0,
            clock,
        }
    }

    pub fn set_duration(&mut self, duration_ms: f64) {
        self.duration_ms = duration_ms.max(0.0);
    }

    pub fn duration_ms(&self) -> f64 { self.duration_ms }
    pub fn playing(&self) -> bool { self.playing }

    pub fn now_ms(&mut self) -> f64 {
        if !self.playing || self.external_sync {
            return self.t_ms;
        }
        let elapsed = ((self.clock)() - self.started_wall_s) * 1000.0;
        let t = self.started_t_ms + elapsed;
        if self.duration_ms > 0.0 && t >= self.duration_ms {
            self.playing = false;
            self.t_ms = self.duration_ms;
            return self.t_ms;
        }
        t
    }

    pub fn play(&mut self) {
        if self.external_sync { return; }
        self.started_wall_s = (self.clock)();
        self.started_t_ms = self.t_ms;
        self.playing = true;
    }

    pub fn pause(&mut self) {
        self.t_ms = self.now_ms();
        self.playing = false;
    }

    pub fn toggle(&mut self) {
        if self.playing { self.pause() } else { self.play() }
    }

    pub fn seek(&mut self, t_ms: f64) {
        let upper = if self.duration_ms > 0.0 { self.duration_ms } else { t_ms };
        let t_ms = t_ms.clamp(0.0, upper.max(0.0));
        self.t_ms = t_ms;
        if self.playing {
            self.started_wall_s = (self.clock)();
            self.started_t_ms = t_ms;
        }
    }

    /// Appelé depuis un récepteur de timecode.
    pub fn apply_external(&mut self, t_ms: f64, fps: f64) {
        self.last_external_fps = Some(fps);
        self.last_external_wall_s = (self.clock)();
        if self.external_sync {
            self.t_ms = t_ms.max(0.0);
            self.playing = true;
        }
    }

    pub fn external_is_live(&self, timeout_s: f64) -> bool {
        self.last_external_wall_s > 0.0
            && ((self.clock)() - self.last_external_wall_s) < timeout_s
    }
}

impl Default for Transport {
    fn default() -> Self { Self::new() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn fake_clock() -> (Arc<Mutex<f64>>, Transport) {
        let t = Arc::new(Mutex::new(0.0f64));
        let t2 = t.clone();
        let transport = Transport::with_clock(Box::new(move || *t2.lock().unwrap()));
        (t, transport)
    }

    /// Oracle : test_core — lecture qui avance, pause qui fige, seek borné.
    #[test]
    fn play_pause_seek_semantics() {
        let (clock, mut tr) = fake_clock();
        tr.set_duration(10_000.0);
        assert_eq!(tr.now_ms(), 0.0);
        tr.play();
        *clock.lock().unwrap() = 2.0;
        assert!((tr.now_ms() - 2000.0).abs() < 1e-9);
        tr.pause();
        *clock.lock().unwrap() = 5.0;
        assert!((tr.now_ms() - 2000.0).abs() < 1e-9);
        tr.seek(8_000.0);
        assert_eq!(tr.now_ms(), 8_000.0);
        tr.seek(99_000.0);
        assert_eq!(tr.now_ms(), 10_000.0); // clamp à la durée
        tr.seek(-5.0);
        assert_eq!(tr.now_ms(), 0.0);
    }

    /// Oracle : la lecture s'arrête d'elle-même en fin de durée.
    #[test]
    fn stops_at_duration_end() {
        let (clock, mut tr) = fake_clock();
        tr.set_duration(1_000.0);
        tr.play();
        *clock.lock().unwrap() = 5.0;
        assert_eq!(tr.now_ms(), 1_000.0);
        assert!(!tr.playing());
    }

    /// Oracle : en sync externe, play() est inopérant et apply_external
    /// pilote la position.
    #[test]
    fn external_sync_drives_position() {
        let (clock, mut tr) = fake_clock();
        tr.set_duration(60_000.0);
        tr.external_sync = true;
        tr.play();
        assert!(!tr.playing());
        // clock > 0 : comme en Python, un last_external_wall à 0.0 exact
        // est traité comme "jamais reçu" (falsy) par external_is_live.
        *clock.lock().unwrap() = 0.1;
        tr.apply_external(12_345.0, 25.0);
        assert_eq!(tr.now_ms(), 12_345.0);
        assert!(tr.playing());
        assert_eq!(tr.last_external_fps, Some(25.0));
        *clock.lock().unwrap() = 0.5;
        assert!(tr.external_is_live(1.0));
        *clock.lock().unwrap() = 2.0;
        assert!(!tr.external_is_live(1.0));
        // fin de sync externe : la position reste pilotable au seek
        tr.external_sync = false;
    }
}
