import { readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve as resolve_path } from 'path';
import { pathToFileURL, resolve, URL } from 'url';
import { mkdirp } from '../filesystem/index.js';
import { __fetch_polyfill } from '../../install-fetch.js';
import { SVELTE_KIT } from '../constants.js';

/** @param {string} html */
function clean_html(html) {
	return html
		.replace(/<!\[CDATA\[[\s\S]*?\]\]>/gm, '')
		.replace(/(<script[\s\S]*?>)[\s\S]*?<\/script>/gm, '$1</' + 'script>')
		.replace(/(<style[\s\S]*?>)[\s\S]*?<\/style>/gm, '$1</' + 'style>')
		.replace(/<!--[\s\S]*?-->/gm, '');
}

/** @param {string} attrs */
export function get_href(attrs) {
	const match = /(?:[\s'"]|^)href\s*=\s*(?:"(.*?)"|'(.*?)'|([^\s>]*))/.exec(attrs);
	return match && (match[1] || match[2] || match[3]);
}

/** @param {string} attrs */
function get_src(attrs) {
	const match = /(?:[\s'"]|^)src\s*=\s*(?:"(.*?)"|'(.*?)'|([^\s>]*))/.exec(attrs);
	return match && (match[1] || match[2] || match[3]);
}

/** @param {string} attrs */
function get_srcset_urls(attrs) {
	const results = [];
	// Note that the srcset allows any ASCII whitespace, including newlines.
	const match = /([\s'"]|^)srcset\s*=\s*(?:"(.*?)"|'(.*?)'|([^\s>]*))/s.exec(attrs);
	if (match) {
		const attr_content = match[1] || match[2] || match[3];
		// Parse the content of the srcset attribute.
		// The regexp is modelled after the srcset specs (https://html.spec.whatwg.org/multipage/images.html#srcset-attribute)
		// and should cover most reasonable cases.
		const regex = /\s*([^\s,]\S+[^\s,])\s*((?:\d+w)|(?:-?\d+(?:\.\d+)?(?:[eE]-?\d+)?x))?/gm;
		let sub_matches;
		while ((sub_matches = regex.exec(attr_content))) {
			results.push(sub_matches[1]);
		}
	}
	return results;
}

const OK = 2;
const REDIRECT = 3;

/** @param {{
 *   cwd: string;
 *   out: string;
 *   log: import('types/internal').Logger;
 *   config: import('types/config').ValidatedConfig;
 *   build_data: import('types/internal').BuildData;
 *   fallback?: string;
 *   all: boolean; // disregard `export const prerender = true`
 * }} opts */
export async function prerender({ cwd, out, log, config, build_data, fallback, all }) {
	__fetch_polyfill();

	const dir = resolve_path(cwd, `${SVELTE_KIT}/output`);

	const seen = new Set();

	const server_root = resolve_path(dir);

	/** @type {import('types/internal').App} */
	const app = await import(pathToFileURL(`${server_root}/server/app.js`).href);

	app.init({
		paths: config.kit.paths,
		prerendering: true,
		read: (file) => readFileSync(join(config.kit.files.assets, file))
	});

	/** @type {(status: number, path: string, parent: string | null, verb: string) => void} */
	const error = config.kit.prerender.force
		? (status, path, parent, verb) => {
				log.error(`${status} ${path}${parent ? ` (${verb} from ${parent})` : ''}`);
		  }
		: (status, path, parent, verb) => {
				throw new Error(`${status} ${path}${parent ? ` (${verb} from ${parent})` : ''}`);
		  };

	const files = new Set([...build_data.static, ...build_data.client]);

	build_data.static.forEach((file) => {
		if (file.endsWith('/index.html')) {
			files.add(file.slice(0, -11));
		}
	});

	/**
	 * @param {string} path
	 */
	function normalize(path) {
		if (config.kit.trailingSlash === 'always') {
			return path.endsWith('/') ? path : `${path}/`;
		} else if (config.kit.trailingSlash === 'never') {
			return !path.endsWith('/') || path === '/' ? path : path.slice(0, -1);
		}

		return path;
	}

	/**
	 * @param {string} path
	 * @param {string?} parent
	 */
	async function visit(path, parent) {
		path = normalize(path);

		if (seen.has(path)) return;
		seen.add(path);

		/** @type {Map<string, import('types/hooks').ServerResponse>} */
		const dependencies = new Map();

		const rendered = await app.render(
			{
				host: config.kit.host,
				method: 'GET',
				headers: {},
				path,
				rawBody: '',
				query: new URLSearchParams()
			},
			{
				prerender: {
					all,
					dependencies
				}
			}
		);

		if (rendered) {
			const response_type = Math.floor(rendered.status / 100);
			const headers = rendered.headers;
			const type = headers && headers['content-type'];
			const is_html = response_type === REDIRECT || type === 'text/html';

			const parts = path.split('/');
			if (is_html && parts[parts.length - 1] !== 'index.html') {
				parts.push('index.html');
			}

			const file = `${out}${parts.join('/')}`;
			mkdirp(dirname(file));

			if (response_type === REDIRECT) {
				const { location } = headers;

				log.warn(`${rendered.status} ${path} -> ${location}`);
				writeFileSync(file, `<meta http-equiv="refresh" content="0;url=${encodeURI(location)}">`);

				return;
			}

			if (rendered.status === 200) {
				log.info(`${rendered.status} ${path}`);
				writeFileSync(file, rendered.body || '');
			} else if (response_type !== OK) {
				error(rendered.status, path, parent, 'linked');
			}

			dependencies.forEach((result, dependency_path) => {
				const response_type = Math.floor(result.status / 100);

				const is_html = result.headers['content-type'] === 'text/html';

				const parts = dependency_path.split('/');
				if (is_html && parts[parts.length - 1] !== 'index.html') {
					parts.push('index.html');
				}

				const file = `${out}${parts.join('/')}`;
				mkdirp(dirname(file));

				if (result.body) writeFileSync(file, result.body);

				if (response_type === OK) {
					log.info(`${result.status} ${dependency_path}`);
				} else {
					error(result.status, dependency_path, path, 'fetched');
				}
			});

			if (is_html && config.kit.prerender.crawl) {
				const cleaned = clean_html(/** @type {string} */ (rendered.body));

				let match;
				const pattern = /<(a|img|link|source)\s+([\s\S]+?)>/gm;

				const hrefs = [];

				while ((match = pattern.exec(cleaned))) {
					const element = match[1];
					const attrs = match[2];

					if (element === 'a' || element === 'link') {
						hrefs.push(get_href(attrs));
					} else {
						if (element === 'img') {
							hrefs.push(get_src(attrs));
						}
						hrefs.push(...get_srcset_urls(attrs));
					}
				}

				for (const href of hrefs) {
					if (!href) continue;

					const resolved = resolve(path, href);
					if (resolved[0] !== '/') continue;

					const parsed = new URL(resolved, 'http://localhost');

					const file = parsed.pathname.replace(config.kit.paths.assets, '').slice(1);
					if (files.has(file)) continue;

					if (parsed.search) {
						// TODO warn that query strings have no effect on statically-exported pages
					}

					await visit(parsed.pathname.replace(config.kit.paths.base, ''), path);
				}
			}
		}
	}

	for (const entry of config.kit.prerender.pages) {
		if (entry === '*') {
			for (const entry of build_data.entries) {
				await visit(entry, null);
			}
		} else {
			await visit(entry, null);
		}
	}

	if (fallback) {
		const rendered = await app.render(
			{
				host: config.kit.host,
				method: 'GET',
				headers: {},
				path: '[fallback]', // this doesn't matter, but it's easiest if it's a string
				rawBody: '',
				query: new URLSearchParams()
			},
			{
				prerender: {
					fallback,
					all: false
				}
			}
		);

		const file = join(out, fallback);
		mkdirp(dirname(file));
		writeFileSync(file, rendered.body || '');
	}
}
