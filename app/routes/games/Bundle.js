const CustomError = require('../../class/CustomError');
const Pool = require('../../class/Connection');
const Request = require('../../class/Request');
const Utils = require('../../class/Utils');

/**
 * @api {SCHEMA} Bundle Bundle
 * @apiGroup Schemas
 * @apiName Bundle
 * @apiDescription The optional properties are included based on the "filters" parameter. If the parameter isn't used, all of the optional properties are included, except where noted.
 * @apiVersion 1.0.0
 *
 * @apiParam (Schema) {Object} bundle
 * @apiParam (Schema) {String=bundle} [bundle.type=bundle] [NOT FILTERABLE] The type of the game. This property is only available for the [GetGames](#api-Games-GetGames) method when used with the parameter "join_all".
 * @apiParam (Schema) {Integer} [bundle.bundle_id] [NOT FILTERABLE] The Steam ID of the game. This property is not available for the [GetGames](#api-Games-GetGames) method when used without the "join_all", "format_array" and "show_id" parameters.
 * @apiParam (Schema) {String} [bundle.name] The name of the game.
 * @apiParam (Schema) {Boolean} [bundle.removed] Whether the game has been removed from the Steam store or not.
 * @apiParam (Schema) {Integer[]} [bundle.apps] The Steam IDs of the apps that are included in the game.
 * @apiParam (Schema) {String} bundle.last_update When the information was last updated in the format YYYY/MM/DD HH:mm:SS (UTC timezone).
 *
 * @apiSampleRequest off
 */

class Bundle {
	/**
	 * @param {import('mysql').PoolConnection} connection
	 * @param {import('express').Request} req
	 * @param {Array<number>} ids
	 */
	static async get(connection, req, ids) {
		const columns = {
			name: 'g_bn.name',
			removed: 'g_b.removed',
		};
		const columnKeys = [...Object.keys(columns), 'apps'];

		const params = Object.assign(
			{},
			{ filters: req.query.filters || req.query.bundle_filters || '' }
		);
		const validator = {
			filters: {
				message: `Must be a comma-separated list containing the following values: ${columnKeys.join(
					', '
				)}`,
				regex: new RegExp(`^(((${columnKeys.join('|')}),?)+)?$`),
			},
		};
		Utils.validateParams(params, validator);

		const filters = {};
		for (const columnKey of columnKeys) {
			filters[columnKey] = true;
		}
		if (params.filters) {
			const filterKeys = params.filters.split(',');
			for (const columnKey of columnKeys) {
				if (!filterKeys.includes(columnKey)) {
					delete columns[columnKey];
					delete filters[columnKey];
				}
			}
		}

		const preparedIds = ids.map((id) => connection.escape(id)).join(',');
		const rows = await Pool.query(
			connection,
			`
				SELECT ${[
					'g_b.bundle_id',
					...Object.values(columns),
					'g_b.last_update',
					'g_b.queued_for_update',
				].join(', ')}
				FROM games__bundle AS g_b
				${
					filters.name
						? `
								INNER JOIN games__bundle_name AS g_bn
								ON g_b.bundle_id = g_bn.bundle_id
							`
						: ''
				}
				WHERE g_b.bundle_id IN (${preparedIds})
			`
		);

		let appMap = {};
		if (filters.apps) {
			const appRows = await Pool.query(
				connection,
				`
					SELECT g_ba.bundle_id, GROUP_CONCAT(g_ba.app_id) AS apps
					FROM games__bundle_app AS g_ba
					WHERE g_ba.bundle_id IN (${preparedIds})
					GROUP BY g_ba.bundle_id
				`
			);
			appMap = Utils.getQueryMap(appRows, 'bundle_id');
		}

		const bundles = [];
		const found = [];
		const to_queue = [];
		const now = Math.trunc(Date.now() / 1e3);
		for (const row of rows) {
			const bundle = {
				bundle_id: row.bundle_id,
			};
			if (filters.name) {
				bundle.name = row.name;
			}
			if (filters.removed) {
				bundle.removed = !!row.removed;
			}
			if (filters.apps) {
				const appRow = appMap[row.bundle_id];
				bundle.apps = appRow ? appRow.apps.split(',').map((appId) => parseInt(appId)) : [];
			}
			bundle.last_update = Utils.formatDate(parseInt(row.last_update) * 1e3, true);
			bundle.queued_for_update = !!row.queued_for_update;
			if (!bundle.queued_for_update) {
				const lastUpdate = Math.trunc(new Date(parseInt(row.last_update) * 1e3).getTime() / 1e3);
				const differenceInSeconds = now - lastUpdate;
				if (
					differenceInSeconds > 60 * 60 * 24 * 6 ||
					(!Utils.isSet(row.name) && !row.removed && differenceInSeconds > 60 * 60 * 24)
				) {
					bundle.queued_for_update = true;
					to_queue.push(bundle.bundle_id);
				}
			}
			bundles.push(bundle);
			found.push(bundle.bundle_id);
		}
		const notFound = ids.filter((id) => !found.includes(id));
		to_queue.push(...notFound);
		if (to_queue.length > 0) {
			await Pool.transaction(connection, async () => {
				await Pool.query(
					connection,
					`
						INSERT INTO games__bundle (bundle_id, queued_for_update)
						VALUES ${to_queue.map((id) => `(${connection.escape(id)}, TRUE)`).join(', ')}
						ON DUPLICATE KEY UPDATE queued_for_update = VALUES(queued_for_update)
					`
				);
			});
		}
		return bundles;
	}

	/**
	 * @param {import('mysql').PoolConnection} connection
	 * @param {number} bundleId
	 */
	static async fetch(connection, bundleId) {
		const storeUrl = `https://store.steampowered.com/bundle/${bundleId}?cc=us&l=en`;
		const storeConfig = {
			headers: {
				Cookie: 'birthtime=0; mature_content=1;',
			},
		};
		const storeResponse = await Request.get(storeUrl, storeConfig);
		if (!storeResponse.html) {
			throw new CustomError(CustomError.COMMON_MESSAGES.steam, 500);
		}
		const isStoreResponseOk = !!storeResponse.html.querySelector('.pageheader');
		const removed = !storeResponse.url.match(
			new RegExp(`store\.steampowered\.com.*?\/bundle\/${bundleId}`)
		);
		const bundleName =
			isStoreResponseOk && !removed
				? storeResponse.html.querySelector('.pageheader').textContent
				: null;
		const bundle = {
			bundle_id: bundleId,
			removed: removed,
			last_update: Math.trunc(Date.now() / 1e3),
			queued_for_update: false,
		};
		const apps = [];
		if (isStoreResponseOk && !removed) {
			const elements = storeResponse.html.querySelectorAll('[data-ds-appid]');
			for (const element of elements) {
				apps.push(parseInt(element.dataset.dsAppid));
			}
		}
		await Pool.beginTransaction(connection);
		try {
			const columns = Object.keys(bundle);
			const values = Object.values(bundle);
			await Pool.query(
				connection,
				`
					INSERT INTO games__bundle (${columns.join(', ')})
					VALUES (${values.map((value) => connection.escape(value)).join(', ')})
					ON DUPLICATE KEY UPDATE ${columns.map((column) => `${column} = VALUES(${column})`).join(', ')}
				`
			);
			if (bundleName) {
				await Pool.query(
					connection,
					`
						INSERT IGNORE INTO games__bundle_name (bundle_id, name)
						VALUES (${connection.escape(bundleId)}, ${connection.escape(bundleName)})
					`
				);
			}
			if (apps.length > 0) {
				await Pool.query(
					connection,
					`
						INSERT IGNORE INTO games__bundle_app (bundle_id, app_id)
						VALUES ${apps
							.map((appId) => `(${connection.escape(bundleId)}, ${connection.escape(appId)})`)
							.join(', ')}
					`
				);
			}
			await Pool.commit(connection);
		} catch (err) {
			await Pool.rollback(connection);
			throw err;
		}
	}
}

module.exports = Bundle;
