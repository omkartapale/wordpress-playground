import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { setURLScope } from '@php-wasm/scopes';

vi.mock('@php-wasm/web-service-worker', () => ({
	convertFetchEventToPHPRequest: vi.fn(async (event: FetchEvent) => {
		if (event.request.url.endsWith('/site-editor.php')) {
			return new Response('<html></html>', {
				headers: {
					'Document-Isolation-Policy': 'isolate-and-credentialless',
				},
			});
		}
		return new Response(
			'window.render = (props) => window.wp.element.createElement("iframe", props);'
		);
	}),
}));
vi.mock('@php-wasm/universal', () => ({}));
vi.mock('@wp-playground/wordpress', () => ({}));
vi.mock('@php-wasm/logger', () => ({ reportServiceWorkerMetrics() {} }));
vi.mock('../lib/offline-mode-cache', () => ({
	isCurrentServiceWorkerActive: () => true,
}));
vi.mock('@wp-playground/remote-access', () => ({
	getRemoteAccessRelayMapping: () => undefined,
	getRemoteAccessRelayMappingFromUrl: () => undefined,
}));

const origin = 'https://playground.wordpress.net';
const scope = 'editor-isolation-test';

describe('Editor iframe isolation', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it.each([
		{ srcDoc: '<!doctype html>' },
		{ src: `blob:${origin}/editor-document` },
		{ src: '/wp-includes/empty.html' },
		{ src: `${origin}/scope:${scope}/wp-includes/empty.html` },
	])('preserves isolation after a worker restart for %j', async (props) => {
		const worker = await createServiceWorker();
		await worker('/wp-admin/site-editor.php');
		const render = await getIframeRenderer(worker, true);
		const iframe = render(props);
		const beforeRestart = await worker(iframe.src);
		expect(beforeRestart.headers.get('Document-Isolation-Policy')).toBe(
			'isolate-and-credentialless'
		);

		// The editor and its script stay loaded while the service worker is retired.
		const restartedWorker = await createServiceWorker();
		const afterRestart = await restartedWorker(render(props).src);
		expect(afterRestart.headers.get('Document-Isolation-Policy')).toBe(
			'isolate-and-credentialless'
		);
	});

	it('does not isolate a non-isolated document in a previously isolated site', async () => {
		const worker = await createServiceWorker();
		await worker('/wp-admin/site-editor.php');
		const render = await getIframeRenderer(worker, false);
		const iframe = render({ src: `blob:${origin}/editor-document` });
		const response = await worker(iframe.src);
		expect(response.headers.has('Document-Isolation-Policy')).toBe(false);
	});

	it('keeps the blob URL in the fragment and removes srcDoc', async () => {
		const worker = await createServiceWorker();
		const render = await getIframeRenderer(worker, true);
		const blobUrl = `blob:${origin}/editor-document`;
		const iframe = render({ src: blobUrl });
		expect(
			decodeURIComponent(new URL(iframe.src, origin).hash.slice(1))
		).toBe(blobUrl);
		expect(render({ srcDoc: '<!doctype html>' }).srcDoc).toBeUndefined();
	});

	it('leaves ordinary iframe URLs unchanged', async () => {
		const worker = await createServiceWorker();
		const render = await getIframeRenderer(worker, true);
		const src = 'https://example.com/preview';
		expect(render({ src }).src).toBe(src);
	});

	it('does not isolate empty.html without an explicit request', async () => {
		const worker = await createServiceWorker();
		const response = await worker('/wp-includes/empty.html');
		expect(response.headers.has('Document-Isolation-Policy')).toBe(false);
	});
});

async function createServiceWorker() {
	vi.resetModules();
	const events = new EventTarget();
	vi.stubGlobal('self', {
		location: new URL('/sw.js', origin),
		addEventListener: events.addEventListener.bind(events),
	});
	await import('../../service-worker');
	return async (path: string): Promise<Response> => {
		let response: Promise<Response> | undefined;
		const event = Object.assign(new Event('fetch'), {
			request: new Request(setURLScope(new URL(path, origin), scope)),
			respondWith(value: Response | Promise<Response>) {
				response = Promise.resolve(value);
			},
		});
		events.dispatchEvent(event);
		if (!response) {
			throw new Error(`Service worker did not handle ${path}`);
		}
		return response;
	};
}

type IframeProps = { src?: string; srcDoc?: string };

async function getIframeRenderer(
	request: (path: string) => Promise<Response>,
	crossOriginIsolated: boolean
): Promise<(props: IframeProps) => IframeProps & { src: string }> {
	const script = await request('/wp-includes/js/dist/block-editor.js');
	// Execute the actual injected wrapper with only its React calls stubbed.
	const window = {
		crossOriginIsolated,
		location: new URL(`/scope:${scope}/wp-admin/site-editor.php`, origin),
		wp: {
			element: {
				forwardRef: (render: unknown) => render,
				useMemo: (callback: () => unknown) => callback(),
				createElement: (
					component: string | ((props: IframeProps) => IframeProps),
					props: IframeProps
				) =>
					typeof component === 'function' ? component(props) : props,
			},
		},
	};
	return runInNewContext(
		'globalThis.window = globalThis;' +
			(await script.text()) +
			'; window.render;',
		{ ...window, URL }
	);
}
