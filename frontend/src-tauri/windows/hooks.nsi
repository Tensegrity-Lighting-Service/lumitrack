; Hooks NSIS (2026-08-06, "Error opening file for writing: lumitrack-
; sidecar.exe" a l'installation) : le template Tauri sait fermer l'app
; principale si elle tourne, mais pas notre processus enfant externalBin —
; un sidecar encore vivant (ou orphelin, cf. CONCEPTION.md 14.6) verrouille
; son exe et fait echouer l'ecrasement. On le termine avant d'ecrire, et
; avant de desinstaller.
!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /IM lumitrack-sidecar.exe'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM lumitrack-sidecar.exe'
!macroend
