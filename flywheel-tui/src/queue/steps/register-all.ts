// Side-effect imports — each module calls registerScaffolding() on load.
// Import this file once to populate the scaffolding registry.
import "./plan-research/scaffolding";
import "./plan-draft/scaffolding";
import "./plan-review/scaffolding";
import "./plan-consolidate/scaffolding";
import "./work/scaffolding";
import "./sprint-verify/scaffolding";
import "./review-dispatch/scaffolding";
import "./review-consolidate/scaffolding";
import "./ship-commit/scaffolding";
import "./ship-learnings/scaffolding";
import "./debug-investigate/scaffolding";
import "./debug-fix/scaffolding";
import "./debug-verify/scaffolding";
import "./research/scaffolding";
// sprint-work scaffolding is handled by the sprint handler directly (bypasses pipeline)
// gate steps have no scaffolding (empty result is the default)
