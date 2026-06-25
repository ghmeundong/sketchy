const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      ...CORS_HEADERS,
    },
  });
}

function errorResponse(message, status = 500) {
  return jsonResponse({ error: message }, status);
}

async function fetchR2Sketch(env) {
  const sketchId = env?.SKETCH_DOCUMENT_ID || "shared";
  const webpKey = `${sketchId}.webp`;
  const jsonKey = `${sketchId}.json`;

  if (!env?.SKETCHES_BUCKET) {
    throw new Error("R2 binding `SKETCHES_BUCKET` is not configured in the Worker environment.");
  }

  const result = { imageData: null, vector: null };

  const webpObj = await env.SKETCHES_BUCKET.get(webpKey);
  if (webpObj) {
    result.imageData = await webpObj.text();
  }

  const jsonObj = await env.SKETCHES_BUCKET.get(jsonKey);
  if (jsonObj) {
    try {
      const txt = await jsonObj.text();
      result.vector = JSON.parse(txt);
    } catch {
      result.vector = null;
    }
  }

  return result;
}

async function deleteR2Sketch(env) {
  const sketchId = env?.SKETCH_DOCUMENT_ID || "shared";
  const webpKey = `${sketchId}.webp`;
  const jsonKey = `${sketchId}.json`;

  if (!env?.SKETCHES_BUCKET) {
    throw new Error("R2 binding `SKETCHES_BUCKET` is not configured in the Worker environment.");
  }

  await env.SKETCHES_BUCKET.delete(webpKey);
  await env.SKETCHES_BUCKET.delete(jsonKey);
  return { ok: true };
}

async function saveR2Sketch(env, sketchPayload) {
  const sketchId = env?.SKETCH_DOCUMENT_ID || "shared";
  const webpKey = `${sketchId}.webp`;
  const jsonKey = `${sketchId}.json`;

  if (!env?.SKETCHES_BUCKET) {
    throw new Error("R2 binding `SKETCHES_BUCKET` is not configured in the Worker environment.");
  }

  if (sketchPayload.imageData && typeof sketchPayload.imageData === "string") {
    await env.SKETCHES_BUCKET.put(webpKey, sketchPayload.imageData, {
      httpMetadata: { contentType: "text/plain" },
    });
  }

  if (Array.isArray(sketchPayload.vector)) {
    await env.SKETCHES_BUCKET.put(jsonKey, JSON.stringify(sketchPayload.vector), {
      httpMetadata: { contentType: "application/json" },
    });
  }

  return { ok: true };
}

async function handleSketchRequest(request, env) {
  if (request.method === "GET") {
    const doc = await fetchR2Sketch(env);
    return jsonResponse({ imageData: doc.imageData || null, vector: doc.vector || null });
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.imageData !== "string") {
      return errorResponse("Request body must include imageData string.", 400);
    }

    await saveR2Sketch(env, { imageData: body.imageData, vector: body.vector });
    return jsonResponse({ ok: true });
  }

  return new Response(null, {
    status: 405,
    headers: CORS_HEADERS,
  });
}

async function handleResetRequest(request, env) {
  if (request.method !== "POST") {
    return new Response(null, {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  const body = await request.json().catch(() => null);
  const expectedToken = env?.SKETCH_RESET_TOKEN;
  if (!expectedToken) {
    return errorResponse("Reset token is not configured.", 500);
  }
  if (!body || typeof body.secret !== "string" || body.secret !== expectedToken) {
    return errorResponse("Invalid reset secret.", 403);
  }

  await deleteR2Sketch(env);
  return jsonResponse({ ok: true, message: "R2 sketch storage reset." });
}

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/api/health") {
    return jsonResponse({ ok: true, timestamp: new Date().toISOString() });
  }

  if (url.pathname === "/api/sketch/reset") {
    try {
      return await handleResetRequest(request, env);
    } catch (error) {
      return errorResponse(error.message || "Failed to reset sketch storage.");
    }
  }

  if (url.pathname === "/api/sketch") {
    try {
      return await handleSketchRequest(request, env);
    } catch (error) {
      return errorResponse(error.message || "Failed to handle sketch request.");
    }
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      ...CORS_HEADERS,
    },
  });
}

export default {
  async fetch(request, env, _context) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }
    return handleRequest(request, env);
  },
};
