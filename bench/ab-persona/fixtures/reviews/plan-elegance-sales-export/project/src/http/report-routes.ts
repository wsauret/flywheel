import { renderSalesHtml, type Sale } from "../reports/sales";
import { stockCsv, type StockLine } from "../reports/stock";

export interface ReportSources {
  salesBetween(from: Date, to: Date): Promise<Sale[]>;
  stockLines(): Promise<StockLine[]>;
}

function range(url: URL): { from: Date; to: Date } {
  const from = new Date(url.searchParams.get("from") ?? "");
  const to = new Date(url.searchParams.get("to") ?? "");
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Response("from and to must be ISO dates", { status: 400 });
  return { from, to };
}

export async function handleReport(request: Request, sources: ReportSources): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/reports/sales") {
    const { from, to } = range(url);
    return new Response(renderSalesHtml(await sources.salesBetween(from, to)), { headers: { "content-type": "text/html" } });
  }
  if (url.pathname === "/reports/stock.csv") {
    return new Response(stockCsv(await sources.stockLines()), { headers: { "content-type": "text/csv" } });
  }
  return new Response("Not found", { status: 404 });
}
