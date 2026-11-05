import * as log from '../ui/log.ts';
import { loadConfig } from '../config/config.ts';
import { detect } from '../detect/detect.ts';
import type { Options, Deps } from '../types.ts';

export function detectCmd(opts: Options, deps: Deps) {
  const cfg = loadConfig(deps.configDir);
  const found = detect({ clientFolder: cfg.client_folder }, deps.env);
  if (cfg.addons_path) log.info(`Configured: ${cfg.addons_path}\n`);
  if (!found.length) {
    log.info(`No AddOns folders found for client folder "${cfg.client_folder}".`);
    return 2;
  }
  for (const c of found) {
    log.info(`${c.addons}${c.exists ? '' : '  (AddOns not created yet)'}`);
    log.info(`    ${c.label}${c.version ? `, game ${c.version}` : ''}${c.forever ? '  [Forever]' : ''}`);
  }
  return 0;
}
