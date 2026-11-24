# Voice model transport (#3498)
Local installer preparation only. No production mirror activation or release.

## Specs
S1. “Adaptar el instalador y agregar pruebas de compatibilidad, integridad y redirecciones.” A trusted build-time model transport may differ from the manifest's historical download location. Unchanged valid installs need no network request or receipt rewrite; retain all file pins and model identity.
S2. “Sin publicar la release ni activar una fuente no verificada.” Keep the current production model and runtime sources. Exercise the release transport through offline fixtures only; no fork dependency, user URL option, uploads or downloads.

## Tasks
T1 | S1–S2 | Implement and verify the local installer change in isolation | done: 73e3afbbd (153 voice tests passed; typecheck, runtime sync and independent baseline/candidate probes passed; native review approved)

## Log
L1. lo podemos implementar nosotros?
L2. Sí, implementá la parte local — Adaptar el instalador y agregar pruebas de compatibilidad, integridad y redirecciones. Sin publicar la release ni activar una fuente no verificada.
