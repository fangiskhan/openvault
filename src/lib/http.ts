export function badRequest(details: unknown) {
  return Response.json({ error: "invalid_request", details }, { status: 400 });
}

export function notFound() {
  return Response.json({ error: "not_found" }, { status: 404 });
}
