// Demo clients — committed fixtures, not localStorage scenarios. They
// must survive schema migrations, cleared browser data, and the two
// deploy origins having separate storage (each keeps its own
// localStorage), so they live in the repo and get written into the
// workspace fresh each time "Load demo clients" runs, exactly like
// any other client a user creates.
//
// Each module exports build(now) → { name, scenarios: [{ name,
// expectAffordable, state }] } — every state built through the real
// factories (createAsset, createLiability, etc.) and clampAllToPlan,
// never a hand-written object literal, so a schema change surfaces as
// a build/test-time break here rather than silent hydration drift.
import { build as buildFirstHomeBuyer } from "./firstHomeBuyer.js";
import { build as buildFamilyWithMortgage } from "./familyWithMortgage.js";
import { build as buildHighEarnerPreRetirement } from "./highEarnerPreRetirement.js";

export const DEMO_BUILDERS = [buildFirstHomeBuyer, buildFamilyWithMortgage, buildHighEarnerPreRetirement];

// buildDemoClients(now) → [{ name, scenarios: [{ name, expectAffordable, state }] }, ...]
// `now` is threaded through so a test can pin it for reproducibility;
// the live app just passes new Date().
export function buildDemoClients(now = new Date()) {
  return DEMO_BUILDERS.map((build) => build(now));
}
