export { extractZipAsync } from "../../release/zip.js";

// the V3 prebuilt path (final ZIP, no browser build). The UI must only
// load releases through this extractor.
export {
  extractPrebuiltZip,
  type PrebuiltZipFile,
  type PrebuiltZipManifest,
  type PrebuiltZipOptions,
  type PrebuiltZipResult,
} from "../../release/prebuilt-zip.js";
