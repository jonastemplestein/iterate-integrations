import type { IterateContextApi } from "iterate/api";

const SIGNING_SECRET = "/secrets/pebble-webhook";
const MAX_CLOCK_SKEW_SECONDS = 300;

/** Pebble Index 01's webhook (webhook protocol version 1): verify the signature, store the audio
 *  as the project file /pebble/<recordingId>.m4a and publish `pebble/recording-created` on /pebble. */
export async function receivePebbleRecording(
  request: Request,
  withItx: <T>(call: (itx: IterateContextApi) => T) => Promise<Awaited<T>>,
): Promise<Response> {
  if (request.method !== "POST") return new Response("POST only\n", { status: 405 });
  if (request.headers.get("x-index-webhook-version") !== "1")
    return new Response("unsupported webhook version\n", { status: 400 });
  const timestamp = Number(request.headers.get("x-index-timestamp"));
  const deliveryId = request.headers.get("x-index-delivery") ?? "";
  const trigger = request.headers.get("x-index-trigger") ?? "";
  const isTest = request.headers.get("x-index-test") === "true";
  if (!Number.isInteger(timestamp) || !deliveryId)
    return new Response("missing timestamp or delivery id\n", { status: 400 });
  if (Math.abs(Date.now() / 1000 - timestamp) > MAX_CLOCK_SKEW_SECONDS)
    return new Response("expired\n", { status: 401 });

  // The app signs "v1\n<timestamp>\n<delivery>\n<trigger>\n<0|1>\n" followed by the raw body.
  const body = new Uint8Array(await request.arrayBuffer());
  const prefix = new TextEncoder().encode(
    "v1\n" + timestamp + "\n" + deliveryId + "\n" + trigger + "\n" + (isTest ? "1" : "0") + "\n",
  );
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const signature = request.headers.get("x-index-signature") ?? "";
  const genuine = await withItx((itx) =>
    itx.secrets.verifyHmac(SIGNING_SECRET, { payload: signed, signature }),
  );
  if (!genuine) return new Response("bad signature\n", { status: 401 });
  if (isTest) return Response.json({ ok: true, test: true });

  const form = await new Response(body, {
    headers: { "content-type": request.headers.get("content-type") ?? "" },
  }).formData();
  const recordedAt = Number(form.get("recordedAt"));
  if (!Number.isFinite(recordedAt)) return new Response("missing recordedAt\n", { status: 400 });
  const transcription = form.get("transcription");
  const audio = form.get("audio");
  // the app names the part <recordingId>.m4a
  const audioName =
    audio instanceof File && /^[A-Za-z0-9._-]+$/.test(audio.name)
      ? audio.name
      : recordedAt + ".m4a";
  const audioPath = audio instanceof File ? "/pebble/" + audioName : null;
  const audioBytes = audio instanceof File ? new Uint8Array(await audio.arrayBuffer()) : null;

  await withItx(async (itx) => {
    if (audioPath && audioBytes)
      await itx.files.get(audioPath).put({ contentType: "audio/mp4", data: audioBytes });
    await itx.cd("/pebble").append({
      type: "pebble/recording-created",
      // a redelivery is the same event with the same payload
      idempotencyKey: "pebble:" + deliveryId,
      payload: {
        deliveryId,
        trigger,
        recordedAt,
        transcript: typeof transcription === "string" ? transcription : null,
        audioPath,
      },
    });
  });
  return Response.json({ ok: true });
}
