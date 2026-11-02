import { buildNativeAddon, nativeAddonBuild } from "./build-native-addon.js";

await buildNativeAddon(nativeAddonBuild("ripgrep"));
