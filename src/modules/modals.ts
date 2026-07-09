import { Notification } from "libs/Notification";
import { closeModal, openModal } from "../util/modal";
import { getClient } from "../util/state";
import { changeRoom } from "./rooms";
import { settings } from "./settings/settings";
import { i18next } from "util/translations";

export function initModals() {
	const gClient = getClient();

	(() => {
		function submit() {
			const msg: any = { m: 'siteban' };
			msg.id = (
				document.querySelector('#siteban .text[name=id]') as HTMLInputElement
			).value;
			const durationUnit = (
				document.querySelector(
					'#siteban select[name=durationUnit]',
				) as HTMLSelectElement
			).value;
			if (durationUnit === 'permanent') {
				if (!gClient.permissions.siteBanAnyDuration) {
					(
						document.querySelector('#siteban p[name=errorText]') as HTMLElement
					).textContent =
						"You don't have permission to ban longer than 1 month.";
					return;
				}
				msg.permanent = true;
			} else {
				const factors: Record<string, number> = {
					seconds: 1000,
					minutes: 60000,
					hours: 3600000,
					days: 86400000,
					weeks: 604800000,
					months: 2592000000,
					years: 31536000000,
				};
				const duration =
					(factors[durationUnit] || 0) *
					parseFloat(
						(
							document.querySelector(
								'#siteban input[name=durationNumber]',
							) as HTMLInputElement
						).value,
					);
				if (duration < 0) {
					(
						document.querySelector('#siteban p[name=errorText]') as HTMLElement
					).textContent = 'Invalid duration.';
					return;
				}
				if (duration > 2592000000 && !gClient.permissions.siteBanAnyDuration) {
					(
						document.querySelector('#siteban p[name=errorText]') as HTMLElement
					).textContent =
						"You don't have permission to ban longer than 1 month.";
					return;
				}
				msg.duration = duration;
			}
			let reason: string;
			if (
				(
					document.querySelector(
						'#siteban select[name=reasonSelect]',
					) as HTMLSelectElement
				).value === 'custom'
			) {
				reason = (
					document.querySelector(
						'#siteban .text[name=reasonText]',
					) as HTMLInputElement
				).value;
				if (reason.length === 0) {
					(
						document.querySelector('#siteban p[name=errorText]') as HTMLElement
					).textContent = 'Please provide a reason.';
					return;
				}
			} else {
				reason = (
					document.querySelector(
						'#siteban select[name=reasonSelect]',
					) as HTMLSelectElement
				).value;
			}
			msg.reason = reason;
			const note = (
				document.querySelector(
					'#siteban textarea[name=note]',
				) as HTMLTextAreaElement
			).value;
			if (note) msg.note = note;
			closeModal();
			gClient.sendArray([msg]);
		}
		document
			.querySelector('#siteban .submit')!
			.addEventListener('click', () => {
				submit();
			});
		document
			.querySelector('#siteban select[name=reasonSelect]')!
			.addEventListener('change', evt => {
				const value = (evt.target as HTMLSelectElement).value;
				if (value === 'custom') {
					(
						document.querySelector(
							'#siteban .text[name=reasonText]',
						) as HTMLInputElement
					).disabled = false;
					(
						document.querySelector(
							'#siteban .text[name=reasonText]',
						) as HTMLInputElement
					).value = '';
				} else {
					(
						document.querySelector(
							'#siteban .text[name=reasonText]',
						) as HTMLInputElement
					).disabled = true;
					(
						document.querySelector(
							'#siteban .text[name=reasonText]',
						) as HTMLInputElement
					).value = value;
				}
			});
		document
			.querySelector('#siteban select[name=durationUnit]')!
			.addEventListener('change', evt => {
				const value = (evt.target as HTMLSelectElement).value;
				if (value === 'permanent')
					(
						document.querySelector(
							'#siteban .text[name=durationNumber]',
						) as HTMLInputElement
					).disabled = true;
				else
					(
						document.querySelector(
							'#siteban .text[name=durationNumber]',
						) as HTMLInputElement
					).disabled = false;
			});
		const textKeypressEvent = (evt: any) => {
			if (evt.keyCode === 13) submit();
			else if (evt.keyCode === 27) closeModal();
			else return;
			if (!settings.noPreventDefault) evt.preventDefault();
			evt.stopPropagation();
			return false;
		};
		document
			.querySelector('#siteban .text[name=id]')!
			.addEventListener('keypress', textKeypressEvent);
		document
			.querySelector('#siteban .text[name=reasonText]')!
			.addEventListener('keypress', textKeypressEvent);
		if (document.querySelector('#siteban .text[name=note]')) {
			document
				.querySelector('#siteban .text[name=note]')!
				.addEventListener('keypress', textKeypressEvent);
		}
	})();

	// Accounts
	(() => {
		function logout() {
			delete localStorage.token;
			delete gClient.accountInfo;
			gClient.stop();
			gClient.start();
			closeModal();
		}
		document
			.querySelector('#account .logout-btn')!
			.addEventListener('click', () => {
				logout();
			});
		document
			.querySelector('#account .login-discord')!
			.addEventListener('click', () => {
				location.replace(
					encodeURI(
						`https://discord.com/api/oauth2/authorize?client_id=926633278100877393&redirect_uri=${location.origin}/?callback=discord&response_type=code&scope=identify email`,
					),
				);
			});
	})();

	// New room dialog
	(() => {
		function submit() {
			const name = (
				document.querySelector('#new-room .text[name=name]') as HTMLInputElement
			).value;
			const roomSettings = {
				visible: (
					document.querySelector(
						'#new-room .checkbox[name=visible]',
					) as HTMLInputElement
				).checked,
				chat: true,
			};
			(
				document.querySelector('#new-room .text[name=name]') as HTMLInputElement
			).value = '';
			closeModal();
			changeRoom(gClient, name, 'right', roomSettings);
			setTimeout(() => {
				new Notification({
					id: 'share',
					title: i18next.t('Created a Room'),
					html:
						i18next.t(
							'You can invite friends to your room by sending them the link.',
						) +
						'<br><a href="' +
						location.href +
						'">' +
						location.href +
						'</a>',
					duration: 25000,
				});
			}, 1000);
		}
		document
			.querySelector('#new-room .submit')!
			.addEventListener('click', () => {
				submit();
			});
		document
			.querySelector('#new-room .text[name=name]')!
			.addEventListener('keypress', (evt: any) => {
				if (evt.keyCode === 13) submit();
				else if (evt.keyCode === 27) closeModal();
				else return;
				if (!settings.noPreventDefault) evt.preventDefault();
				evt.stopPropagation();
				return false;
			});
	})();

	// Rename dialog
	(() => {
		
		// Name Preview
		function updatePreview() {
			if (!gClient.user) return;
			(
				document.querySelector('#namediv-preview .nametext') as HTMLElement
			).innerText = gClient.user.name;
			(
				document.querySelector('#namediv-preview') as HTMLElement
			).style.backgroundColor = gClient.user.color;
			(
				document.querySelector('#rename .rename-hex') as HTMLInputElement
			).value = gClient.user.color;
			if (gClient.user.tag) {
				switch (typeof gClient.user.tag) {
					case 'object':
						(document.querySelector('#namediv-preview .nametag') as HTMLElement).innerText = gClient.user.tag.text;
						(document.querySelector('#namediv-preview .nametag') as HTMLElement).style.backgroundColor = gClient.user.tag.color;
						break;
					case 'string':
						function tagColor(tag: any): string {
							if (typeof tag === 'object') return tag.color;
							if (tag === 'BOT') return '#55f';
							if (tag === 'OWNER') return '#a00';
							if (tag === 'ADMIN') return '#f55';
							if (tag === 'MOD') return '#0a0';
							if (tag === 'MEDIA') return '#f5f';
							return '#777';
						}
						(document.querySelector('#namediv-preview .nametag') as HTMLElement).innerText = gClient.user.tag;
						(document.querySelector('#namediv-preview .nametag') as HTMLElement).style.backgroundColor = tagColor(gClient.user.tag);
						break;
					case 'undefined':
						(document.querySelector('#namediv-preview .nametag') as HTMLElement).style.display = 'none';
						break;
				}
			} else {
				(document.querySelector('#namediv-preview .nametag') as HTMLElement).style.display = 'none';
			}
		}

		function submit() {
			const set = {
				name: (
					document.querySelector('#rename input[name=name]') as HTMLInputElement
				).value,
				color: (
					document.querySelector(
						'#rename input[name=color]',
					) as HTMLInputElement
				).value,
			};
			closeModal();
			gClient.sendArray([{ m: 'userset', set }]);
		}
		document.querySelector('#rename input[name=name]').addEventListener('input', () => {
			// User Name
			(
				document.querySelector('#rename .nametext') as HTMLElement
			).innerText = (
				document.querySelector('#rename input[name=name]') as HTMLInputElement
			).value;
		});
		document.querySelector('#rename input[name=color]').addEventListener('input', () => {
			// User Color
			(
				document.querySelector('#namediv-preview') as HTMLElement
			).style.backgroundColor = (
				document.querySelector('#rename input[name=color]') as HTMLInputElement
			).value;
		})
		document.querySelector('#rename #rename-random-color').addEventListener('click', () => {
			let newHex = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
			(document.querySelector('#rename .rename-hex') as HTMLInputElement).value = newHex;
			(document.querySelector('#namediv-preview') as HTMLElement).style.backgroundColor = newHex;
			(document.querySelector('#rename input[name=color]') as HTMLInputElement).value = newHex;

		})
		document.querySelector('#rename .rename-hex').addEventListener('input', () => {
			let val = (
				document.querySelector('#rename .rename-hex') as HTMLInputElement
			).value;
			let isValidHex = (str: string) => /^#[0-9a-fA-F]{6}$/.test(str);

			if (isValidHex(val)) {
				(document.querySelector('#rename .rename-hex') as HTMLInputElement).style.color = "#ffffff";
				(document.querySelector('#namediv-preview') as HTMLElement).style.backgroundColor = val;
				(document.querySelector('#rename input[name=color]') as HTMLInputElement).value = val;
			} else {
				(document.querySelector('#rename .rename-hex') as HTMLInputElement).style.color = "#ff0000"
				if (val.startsWith("#")) {
					(document.querySelector('#rename #hexvalidatpr') as HTMLElement).innerText = "Invalid Hex! may start with an #";
				} else {
					(document.querySelector('#rename #hexvalidatpr') as HTMLElement).innerText = "Invalid Hex!";
				}
			}
		})
		document.querySelector('#rename .submit')!.addEventListener('click', () => {
			submit();
		});
		document
			.querySelector('#rename .text[name=name]')!
			.addEventListener('keypress', (evt: any) => {
				if (evt.keyCode === 13) submit();
				else if (evt.keyCode === 27) closeModal();
				else return;
				if (!settings.noPreventDefault) evt.preventDefault();
				evt.stopPropagation();
				return false;
			});
	})();



	document
		.getElementById('new-room-btn')!
		.addEventListener('click', (evt: any) => {
			evt.stopPropagation();
			openModal('#new-room', 'input[name=name]');
		});
	document
		.getElementById('play-alone-btn')!
		.addEventListener('click', (evt: any) => {
			evt.stopPropagation();
			const room_name = 'Room' + Math.floor(Math.random() * 1000000000000);
			changeRoom(gClient, room_name, 'right', { visible: false });
			setTimeout(() => {
				new Notification({
					id: 'share',
					title: i18next.t('Playing alone'),
					html:
						i18next.t(
							'You are playing alone in a room by yourself, but you can always invite friends by sending them the link.',
						) +
						'<br><a href="' +
						location.href +
						'">' +
						location.href +
						'</a>',
					duration: 25000,
				});
			}, 1000);
		});

	document
		.getElementById('account-btn')!
		.addEventListener('click', (evt: any) => {
			evt.stopPropagation();
			openModal('#account');
			if (gClient.accountInfo) {
				(
					document.querySelector('#account #account-info') as HTMLElement
				).style.display = 'block';
				if (gClient.accountInfo.type === 'discord') {
					(
						document.querySelector('#account #avatar-image') as HTMLImageElement
					).src = gClient.accountInfo.avatar ?? 'https://placehold.co/300x300';
					document.querySelector('#account #logged-in-user-text')!.textContent =
						`@${gClient.accountInfo.username}`;
				}
			} else {
				(
					document.querySelector('#account #account-info') as HTMLElement
				).style.display = 'none';
			}
		});

	// Modal background click
	const modal_bg = document.querySelector('#modal .bg') as HTMLElement;
	modal_bg.addEventListener('click', (evt: any) => {
		if (evt.target !== modal_bg) return;
		closeModal();
	});
}
