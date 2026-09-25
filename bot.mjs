export default async () => {
  const username = String(process.env.BOT_USERNAME || "").replace(/^@/, "").trim();
  if (!username) {
    return new Response("BOT_USERNAME is not configured.", { status: 500 });
  }
  return new Response(null, {
    status: 302,
    headers: { Location: `https://t.me/${username}` }
  });
};
