import noBarrelFile from "./oxlint-plugin-flywheel/rules/no-barrel-file.js";
import noEffectEscapeHatch from "./oxlint-plugin-flywheel/rules/no-effect-escape-hatch.js";
import noSchemaClass from "./oxlint-plugin-flywheel/rules/no-schema-class.js";
import noRecord from "./oxlint-plugin-flywheel/rules/no-record.js";
import noShoutyConstants from "./oxlint-plugin-flywheel/rules/no-shouty-constants.js";
import noTmpLiteralPath from "./oxlint-plugin-flywheel/rules/no-tmp-literal-path.js";
import noUnsupportedEffectApi from "./oxlint-plugin-flywheel/rules/no-unsupported-effect-api.js";
import preferSchemaInferredTypes from "./oxlint-plugin-flywheel/rules/prefer-schema-inferred-types.js";
import requireSuppressionReason from "./oxlint-plugin-flywheel/rules/require-suppression-reason.js";

export default {
  meta: {
    name: "flywheel",
  },
  rules: {
    "no-barrel-file": noBarrelFile,
    "no-effect-escape-hatch": noEffectEscapeHatch,
    "no-schema-class": noSchemaClass,
    "no-record": noRecord,
    "no-shouty-constants": noShoutyConstants,
    "no-tmp-literal-path": noTmpLiteralPath,
    "no-unsupported-effect-api": noUnsupportedEffectApi,
    "prefer-schema-inferred-types": preferSchemaInferredTypes,
    "require-suppression-reason": requireSuppressionReason,
  },
};
