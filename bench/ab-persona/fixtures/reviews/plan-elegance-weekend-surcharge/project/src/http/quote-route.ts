import { quoteDelivery } from "../pricing/quote";

export async function handleQuote(request: Request, now: () => Date = () => new Date()): Promise<Response> {
  const body: unknown = await request.json().catch(() => undefined);
  const input = typeof body === "object" && body !== null ? { ...body } : {};
  const distanceKm = "distanceKm" in input && typeof input.distanceKm === "number" && input.distanceKm >= 0 ? input.distanceKm : undefined;
  if (distanceKm === undefined) return Response.json({ error: "distanceKm must be a non-negative number" }, { status: 400 });
  const bulky = "bulky" in input && input.bulky === true;
  return Response.json(quoteDelivery({ distanceKm, bulky }, now()));
}
