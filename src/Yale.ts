import * as NodeFetch from 'node-fetch'
import { JSONDecoders } from './Decoders'
import { Decoder } from 'type-safe-json-decoder'

export namespace Yale {
	const yaleAuthToken =
		'VnVWWDZYVjlXSUNzVHJhcUVpdVNCUHBwZ3ZPakxUeXNsRU1LUHBjdTpkd3RPbE15WEtENUJ5ZW1GWHV0am55eGhrc0U3V0ZFY2p0dFcyOXRaSWNuWHlSWHFsWVBEZ1BSZE1xczF4R3VwVTlxa1o4UE5ubGlQanY5Z2hBZFFtMHpsM0h4V3dlS0ZBcGZzakpMcW1GMm1HR1lXRlpad01MRkw3MGR0bmNndQ=='

	const enum Path {
		auth = 'o/token',
		panelMode = 'api/panel/mode',
		deviceStatus = 'api/panel/device_status',
	}

	function url(path: Path): string {
		return `https://mob.yalehomesystem.co.uk/yapi/${path}/`
	}

	async function fetchAccessToken(
		username: string,
		password: string
	): Promise<NodeFetch.Response> {
		return await NodeFetch.default(url(Path.auth), {
			method: 'POST',
			body: `grant_type=password&username=${encodeURIComponent(
				username
			)}&password=${encodeURIComponent(password)}`,
			headers: {
				Authorization: `Basic ${yaleAuthToken}`, // without this, error === 'invalid_client'
				'Content-Type': 'application/x-www-form-urlencoded ; charset=utf-8',
			},
		})
	}

	async function fetchStatus(accessToken: string): Promise<NodeFetch.Response> {
		return await NodeFetch.default(url(Path.panelMode), {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		})
	}

	async function runSetStatus(
		accessToken: string,
		alarmState: AlarmState
	): Promise<NodeFetch.Response> {
		return await NodeFetch.default(url(Path.panelMode), {
			method: 'POST',
			body: `area=1&mode=${alarmState}`,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				'Content-Type': 'application/x-www-form-urlencoded ; charset=utf-8',
			},
		})
	}

	async function fetchDevices(
		accessToken: string
	): Promise<NodeFetch.Response> {
		return await NodeFetch.default(url(Path.deviceStatus), {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
		})
	}

	async function processResponse<T, U>(
		response: NodeFetch.Response,
		decoder: Decoder<T>,
		success: (decoded: T) => U
	): Promise<U> {
		if (response.status === 200) {
			let decoded = decoder.decodeAny(await response.json())
			return success(decoded)
		} else if (response.status >= 400 && response.size < 500) {
			/**
				So far we've seen the following errors: 
				HTTP 400 'invalid_request' (missing username or password)
				HTTP 400 'unsupported_grant_type' (missing grant_type in request body)
				HTTP 401 'invalid_grant' (incorrect username or password)
			*/
			let error = JSONDecoders.errorDecoder.decodeAny(await response.json())
			if (error.description) {
				throw new Error(
					`HTTP ${response.status} "${error.error}", "${error.description}"`
				)
			} else {
				throw new Error(
					`HTTP ${response.status} "${error.error}", No description given.`
				)
			}
		}
		throw new Error(`Unhandled HTTP status code: ${response.status}`)
	}

	export interface AccessToken {
		token: string
		expiration: Date
	}

	export async function getAccessToken(
		username: string,
		password: string
	): Promise<AccessToken> {
		let response = await fetchAccessToken(username, password)
		return await processResponse(
			response,
			JSONDecoders.accessTokenDecoder,
			(accessToken: JSONDecoders.AccessToken) => {
				let expiration = new Date()
				expiration.setSeconds(expiration.getSeconds() + accessToken.expiration)
				return {
					token: accessToken.token,
					expiration: expiration,
				}
			}
		)
	}

	export const enum AlarmState {
		arm = 'arm',
		home = 'home',
		disarm = 'disarm',
	}

	export async function getStatus(
		accessToken: AccessToken
	): Promise<AlarmState> {
		let response = await fetchStatus(accessToken.token)
		return processResponse(
			response,
			JSONDecoders.panelGetDecoder,
			(state: JSONDecoders.PanelGetResponse[]) => {
				switch (
					state[0].mode // TODO: bound-checking
				) {
					case 'arm':
						return AlarmState.arm
					case 'home':
						return AlarmState.home
					case 'disarm':
						return AlarmState.disarm
					default:
						throw new Error('wow')
				}
			}
		)
	}

	export async function setStatus(
		accessToken: AccessToken,
		alarmState: AlarmState
	): Promise<AlarmState> {
		let response = await runSetStatus(accessToken.token, alarmState)
		return processResponse(
			response,
			JSONDecoders.panelSetDecoder,
			(status: JSONDecoders.PanelSetResponse) => {
				if (status.acknowledgement === 'OK') {
					return alarmState
				} else {
					throw new Error('Something went wrong.')
				}
			}
		)
	}

	export interface Device {
		identifier: string
		name: string
	}

	export namespace ContactSensor {
		export enum State {
			None,
			Open,
			Closed,
		}

		export function parse(value: string): State {
			switch (status) {
				case 'device_status.dc_close':
					return State.Closed
				case 'device.status.dc_open':
					return State.Open
				default:
					return State.None
			}
		}

		export interface Sensor extends Device {
			state: State
		}
	}

	export namespace MotionSensor {
		export enum State {
			None,
			Triggered,
		}

		export function parse(value: string): State {
			switch (status) {
				case 'device_status.pir_triggered':
					return State.Triggered
				default:
					return State.None
			}
		}

		export interface Sensor extends Device {
			state: State
		}
	}

	export namespace Sensor {
		export type Sensor = ContactSensor.Sensor | MotionSensor.Sensor

		export function parse(value: JSONDecoders.Device): Sensor | undefined {
			switch (value.type) {
				case 'device_type.door_contact':
					return {
						identifier: value.id,
						name: value.name,
						state: ContactSensor.parse(value.status),
					}
				case 'device_type.pir':
					return {
						identifier: value.id,
						name: value.name,
						state: MotionSensor.parse(value.status),
					}
				default:
					return undefined
			}
		}
	}

	export const isPresent = <T>(value: T): value is NonNullable<T> =>
		value != null

	export async function getDevices(
		accessToken: AccessToken
	): Promise<Sensor.Sensor[]> {
		let response = await fetchDevices(accessToken.token)
		return processResponse(
			response,
			JSONDecoders.devicesDecoder,
			(devices: JSONDecoders.Device[]) => {
				return devices.map(Sensor.parse).filter(isPresent)
			}
		)
	}
}