// Re-export from platform daemon. Fix-cycle is not Jules-specific.
// Jules passes its own identity; any persona can use the same lifecycle.
import { runFixCycle as _runFixCycle } from "../../daemon/fix-cycle.js";
import { JULES_DEFINITION } from "./config/definition.js";
import { resolveOutputContext } from "../../config/service.js";
import { requireOutputFileSystem } from "../../config/output-filesystem.js";

export async function runFixCycle(opts = {}) {
  const outputFs = Object.hasOwn(opts, "outputFs")
    ? requireOutputFileSystem(opts.outputFs)
    : (await resolveOutputContext({ cwd: opts.rootPath || process.cwd(), outputDirOverride: ".sentinelayer" })).outputFs;
  return _runFixCycle({
    ...opts,
    outputFs,
    agentIdentity: {
      id: JULES_DEFINITION.id,
      persona: JULES_DEFINITION.persona,
      color: JULES_DEFINITION.color,
      avatar: JULES_DEFINITION.avatar,
      signature: JULES_DEFINITION.signature,
    },
  });
}
