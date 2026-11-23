// Hogar temporal para una prueba que se ejecuta suelta (publicar-paquetes-drakonc
// 1.7). Se importa SIEMPRE como primera sentencia del archivo de prueba: los
// imports se evalúan en orden, así que este módulo corre antes que cualquier
// módulo bajo prueba y toda resolución perezosa de os.homedir(), de ~/.pi/agent
// o del hogar del agente cae en el directorio temporal en vez del hogar real.
// PI_CODING_AGENT_DIR apunta al mismo <temporal>/.pi/agent que ya resolvía el
// hogar por defecto bajo este HOME, así que el comportamiento visible no cambia.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "drakonc-pi-test-home-"));
const agentDir = join(root, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });

process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.PI_CODING_AGENT_DIR = agentDir;
// Un marcador heredado del shell del desarrollador apuntaría al hogar real.
delete process.env.DRAKONC_PI_AGENT_HOME;

const cleanup = () => rmSync(root, { recursive: true, force: true });
process.once("exit", cleanup);
