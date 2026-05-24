import type { ConfettiParticle } from '../types';
let maxParticleCount = 340;
let particleSpeed = 1.70;
let streamingConfetti = false;
let animationTimer: number | null = null;
let particles: ConfettiParticle[] = [];
let waveAngle = 0;
const colors = [
	'DodgerBlue',
	'OliveDrab',
	'Gold',
	'Pink',
	'SlateBlue',
	'LightBlue',
	'Violet',
	'PaleGreen',
	'SteelBlue',
	'SandyBrown',
	'Chocolate',
	'Crimson',
];

function resetParticle(
	particle: Partial<ConfettiParticle>,
	width: number,
	height: number,
): ConfettiParticle {
	particle.color = colors[(Math.random() * colors.length) | 0];
	particle.x = Math.random() * width;
	particle.y = Math.random() * height - height;
	particle.diameter = Math.random() * 10 + 5;
	particle.tilt = Math.random() * 10 - 10;
	particle.tiltAngleIncrement = Math.random() * 0.07 + 0.05;
	particle.tiltAngle = 0;
	return particle as ConfettiParticle;
}

export function startConfetti() {
	const width = window.innerWidth;
	const height = window.innerHeight;
	let canvas = document.getElementById(
		'confetti-canvas',
	) as HTMLCanvasElement | null;
	if (!canvas) {
		canvas = document.createElement('canvas');
		canvas.id = 'confetti-canvas';
		canvas.setAttribute(
			'style',
			'display:block;z-index:999999;pointer-events:none;position:absolute;top:0;left:0',
		);
		document.body.appendChild(canvas);
		canvas.width = width;
		canvas.height = height;
		window.addEventListener(
			'resize',
			() => {
				canvas!.width = window.innerWidth;
				canvas!.height = window.innerHeight;
			},
			true,
		);
	}
	const context = canvas.getContext('2d')!;
	while (particles.length < maxParticleCount)
		particles.push(resetParticle({}, width, height));
	streamingConfetti = true;
	if (animationTimer === null) {
		(function runAnimation() {
			context.clearRect(0, 0, window.innerWidth, window.innerHeight);
			if (particles.length === 0) animationTimer = null;
			else {
				updateParticles();
				drawParticles(context);
				animationTimer = requestAnimationFrame(runAnimation);
			}
		})();
	}
}

function stopConfetti() {
	streamingConfetti = false;
}
export function removeConfetti() {
	stopConfetti();
	particles = [];
}

function drawParticles(context: CanvasRenderingContext2D) {
	for (let i = 0; i < particles.length; i++) {
		const p = particles[i];
		context.beginPath();
		context.lineWidth = p.diameter;
		context.strokeStyle = p.color;
		context.shadowColor = 'rgba(0, 0, 0, .3)';
		context.shadowBlur = 4;
		context.shadowOffsetY = 2;
		context.shadowOffsetX = 0;
		const x = p.x + p.tilt;
		context.moveTo(x + p.diameter / 2, p.y);
		context.lineTo(x, p.y + p.tilt + p.diameter / 2);
		context.stroke();
	}
}

function updateParticles() {
	const width = window.innerWidth;
	const height = window.innerHeight;
	waveAngle += 0.01;
	for (let i = 0; i < particles.length; i++) {
		const p = particles[i];
		if (!streamingConfetti && p.y < -15) p.y = height + 100;
		else {
			p.tiltAngle += p.tiltAngleIncrement;
			p.x += Math.sin(waveAngle);
			p.y += (Math.cos(waveAngle) + p.diameter + particleSpeed) * 0.5;
			p.tilt = Math.sin(p.tiltAngle) * 15;
		}
		if (p.x > width + 20 || p.x < -20 || p.y > height) {
			if (streamingConfetti && particles.length <= maxParticleCount)
				resetParticle(p, width, height);
			else {
				particles.splice(i, 1);
				i--;
			}
		}
	}
}
