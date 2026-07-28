//! Moteur Lumitrack — port Rust du `core/` Python (refonte native décidée le
//! 2026-07-28 : application 100 % native, un seul processus, zéro webview).
//!
//! Règle de portage : la suite pytest du moteur Python (58 tests) est
//! l'ORACLE. Chaque module porté embarque la traduction de ses tests ;
//! aucun comportement n'est "amélioré" pendant le port — d'abord la parité,
//! ensuite seulement les évolutions.

pub mod easing;
pub mod model;
pub mod psn;
pub mod timecode;
pub mod timeline;
pub mod transform;
pub mod transport;
