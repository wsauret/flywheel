/** Resolves the successor document and its entry assets without touching live owners. */
export async function prepareDocumentReplacement(url: string): Promise<void> {
  const response = await fetch(url, { cache: "reload" })
  if (!response.ok) throw new Error("The successor page is unavailable")
  const page = new DOMParser().parseFromString(await response.text(), "text/html")
  if (!page.querySelector("#root[data-client-identity]")) throw new Error("The successor client is not ready")
  const assets = [
    ...[...page.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map((script) => script.getAttribute("src")),
    ...[...page.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')].map((link) => link.getAttribute("href")),
  ]
  await Promise.all(assets.map(async (asset) => {
    if (asset === null) return
    const loaded = await fetch(new URL(asset, response.url || url), { cache: "reload" })
    if (!loaded.ok) throw new Error("A successor asset is unavailable")
    await loaded.arrayBuffer()
  }))
}
