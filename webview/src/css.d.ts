/** Style sheets are bundled by esbuild, not imported as values. The declaration
 *  exists so the compiler agrees that importing one is meaningful. */
declare module "*.css"
