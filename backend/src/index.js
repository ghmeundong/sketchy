const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Credentials": "true", // 쿠키나 세션 인증 공유가 필요할 수 있으므로 추가
  "Access-Control-Max-Age": "86400",
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
  const jsonKey = `${sketchId}.json`;

  if (!env?.SKETCHES_BUCKET) {
    throw new Error("R2 binding `SKETCHES_BUCKET` is not configured in the Worker environment.");
  }

  const result = { imageData: null, vector: null };
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
  const jsonKey = `${sketchId}.json`;

  if (!env?.SKETCHES_BUCKET) {
    throw new Error("R2 binding `SKETCHES_BUCKET` is not configured in the Worker environment.");
  }

  await env.SKETCHES_BUCKET.delete(jsonKey);
  return { ok: true };
}

async function saveR2Sketch(env, sketchPayload) {
  const sketchId = env?.SKETCH_DOCUMENT_ID || "shared";
  const jsonKey = `${sketchId}.json`;

  if (!env?.SKETCHES_BUCKET) {
    throw new Error("R2 binding `SKETCHES_BUCKET` is not configured in the Worker environment.");
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
    return jsonResponse({ imageData: null, vector: doc.vector || null });
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || !Array.isArray(body.vector)) {
      return errorResponse("Request body must include a vector array.", 400);
    }

    await saveR2Sketch(env, { vector: body.vector });
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
    // 2. 브라우저가 본 요청(POST)을 보내기 전 안전을 확인하는 OPTIONS(Preflight) 요청 완벽 방어
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS_HEADERS,
          // 요청한 브라우저의 Origin을 동적으로 매칭해주면 가장 안전합니다.
          "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
        },
      });
    }

    // 3. 일반 요청(GET, POST 등) 처리할 때도 동적 Origin을 적용하도록 래핑하여 handleRequest 호출
    try {
      const response = await handleRequest(request, env);

      // 기존 response의 헤더를 복사하면서 CORS 헤더가 유실되지 않도록 재확인합니다.
      const newHeaders = new Headers(response.headers);
      Object.entries(CORS_HEADERS).forEach(([key, value]) => {
        if (key === "Access-Control-Allow-Origin") {
          newHeaders.set(key, request.headers.get("Origin") || "*");
        } else {
          newHeaders.set(key, value);
        }
      });

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    } catch (error) {
      return errorResponse(error.message || "Internal Server Error");
    }
  },
};
