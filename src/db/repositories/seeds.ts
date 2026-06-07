import type { Database } from "bun:sqlite";

import type { ConfigSeeds } from "../../config/schema.ts";
import { createAccessRuleRepository } from "./access-rules.ts";
import { createProfileRepository } from "./profiles.ts";
import { createTargetRepository } from "./targets.ts";

export function seedDatabaseFromConfig(
  db: Database,
  seeds: ConfigSeeds,
  now: () => Date = () => new Date(),
): void {
  const seed = db.transaction(() => {
    const targets = createTargetRepository(db, now);
    const profiles = createProfileRepository(db, now);
    const accessRules = createAccessRuleRepository(db, { now });

    for (const target of seeds.targets) {
      targets.upsertSeed(target);
    }

    for (const profile of seeds.profiles) {
      profiles.upsertSeed(profile);
    }

    for (const rule of seeds.accessRules) {
      accessRules.upsertSeed(rule);
    }
  });

  seed();
}
