const allowedOrigins = new Set([
    'https://altdirect.app',
    'https://celloserenity.github.io'
]);
const maxBytes = 5 * 1024 * 1024;

function responseHeaders(origin) {
    return {
        'Access-Control-Allow-Origin': origin,
        'Content-Type': 'application/json; charset=utf-8',
        Vary: 'Origin'
    };
}

function error(message, status, origin) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: responseHeaders(origin)
    });
}

function validUrl(value, workerHost) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        url.hostname === workerHost || url.hostname === 'localhost' ||
        url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') ||
        !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) {
        throw new Error('Invalid source URL');
    }
    return url;
}

function withoutTrailingCommas(value) {
    const result = [];
    let quoted = false;
    let escaped = false;
    for (let i = 0; i < value.length; i++) {
        const char = value[i];
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
        } else if (char === '"') {
            quoted = true;
        } else if (char === ',') {
            let next = i + 1;
            while (next < value.length && /\s/.test(value[next])) next++;
            if (value[next] === ']' || value[next] === '}') continue;
        }
        result.push(char);
    }
    return result.join('');
}

function recoverSourceMetadata(body, bundleIdentifier) {
    const start = body.search(/\S/);
    if (body[start] !== '{') return null;

    const source = {};
    const stack = ['}'];
    const quoted = /"(?:[^"\\]|\\[\s\S])*"/y;
    const separator = /\s*:\s*/y;
    const valueEnd = /\s*[,}]/y;
    let appsStart = -1;
    let inApps = false;
    let app;
    let previous = '{';
    let expectingKey = true;
    for (let i = start + 1; i < body.length && stack.length; i++) {
        const char = body[i];
        if (/\s/.test(char)) continue;
        if (char === '"') {
            quoted.lastIndex = i;
            const token = quoted.exec(body);
            if (!token) break;
            i = quoted.lastIndex - 1;
            const metadata = stack.length === 1 ? source : stack.length === 3 ? app : null;
            if (metadata && expectingKey) {
                try {
                    const key = JSON.parse(token[0]);
                    separator.lastIndex = i + 1;
                    if (separator.test(body)) {
                        if (metadata === source && bundleIdentifier && key === 'apps' && body[separator.lastIndex] === '[') {
                            appsStart = separator.lastIndex;
                        } else if (key === 'name' || key === 'iconURL' ||
                            (metadata === source ? key === 'subtitle' : key === 'bundleIdentifier' || key === 'developerName')) {
                            quoted.lastIndex = separator.lastIndex;
                            const value = quoted.exec(body);
                            if (value) {
                                valueEnd.lastIndex = quoted.lastIndex;
                                if (valueEnd.test(body)) metadata[key] = JSON.parse(value[0]);
                            }
                        }
                    }
                } catch (_) {
                    // Ignore invalid string escapes in metadata.
                }
            }
        } else if (char === '{' || char === '[') {
            if (i === appsStart) inApps = true;
            if (inApps && stack.length === 2 && char === '{' && (previous === '[' || previous === ',')) app = {};
            stack.push(char === '{' ? '}' : ']');
        } else if (char === '}' || char === ']') {
            if (stack.pop() !== char) break;
            if (stack.length === 2 && app) {
                if (app.bundleIdentifier === bundleIdentifier && app.name?.trim()) return { apps: [app] };
                app = null;
            }
            if (stack.length === 1) inApps = false;
        }
        expectingKey = char === ',' || char === '{';
        previous = char;
    }
    if (app && app.bundleIdentifier === bundleIdentifier && app.name?.trim()) return { apps: [app] };
    return source.name?.trim() ? source : null;
}

export default {
    async fetch(request) {
        const origin = request.headers.get('Origin');
        if (!allowedOrigins.has(origin)) return new Response(null, { status: 403 });

        const requestUrl = new URL(request.url);
        if (requestUrl.pathname !== '/api/source') return error('Not found', 404, origin);
        if (request.method !== 'GET') return error('Method not allowed', 405, origin);

        const value = requestUrl.searchParams.get('url');
        const bundleIdentifier = requestUrl.searchParams.get('app');
        if (!value || value.length > 2048) return error('Invalid source URL', 400, origin);

        let target;
        try {
            target = validUrl(value, requestUrl.hostname);
        } catch (_) {
            return error('Invalid source URL', 400, origin);
        }

        try {
            for (let redirects = 0; redirects <= 3; redirects++) {
                const response = await fetch(target.href, {
                    headers: { Accept: 'application/json' },
                    redirect: 'manual',
                    signal: AbortSignal.timeout(10000)
                });

                if (response.status >= 300 && response.status < 400) {
                    const location = response.headers.get('Location');
                    if (!location || redirects === 3) return error('Too many redirects', 502, origin);
                    target = validUrl(new URL(location, target).href, requestUrl.hostname);
                    continue;
                }
                if (!response.ok) return error('Source returned HTTP ' + response.status, 502, origin);
                if (Number(response.headers.get('Content-Length')) > maxBytes) return error('Source is too large', 413, origin);

                const reader = response.body.getReader();
                const chunks = [];
                let total = 0;
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    total += value.byteLength;
                    if (total > maxBytes) {
                        await reader.cancel();
                        return error('Source is too large', 413, origin);
                    }
                    chunks.push(value);
                }

                const bytes = new Uint8Array(total);
                let offset = 0;
                for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                const body = new TextDecoder().decode(bytes);
                let source;
                try {
                    source = JSON.parse(body);
                } catch (_) {
                    try {
                        source = JSON.parse(withoutTrailingCommas(body));
                    } catch (_) {
                        source = recoverSourceMetadata(body, bundleIdentifier);
                        if (!source) return error('Source did not return usable JSON', 502, origin);
                    }
                }
                const hasApp = bundleIdentifier && Array.isArray(source?.apps) &&
                    source.apps.some(app => app?.bundleIdentifier === bundleIdentifier && typeof app.name === 'string' && app.name.trim());
                if (!hasApp && typeof source?.name !== 'string') return error('Invalid source', 422, origin);
                return new Response(JSON.stringify(source), { headers: responseHeaders(origin) });
            }
        } catch (_) {
            return error('Could not fetch source', 502, origin);
        }
    }
};
