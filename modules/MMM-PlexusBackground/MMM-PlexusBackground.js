Module.register("MMM-PlexusBackground", {
	defaults: {
		particleCount: 70,
		particleSize: 3,
		lineThickness: 1.5,
		connectionDistance: 200,
		speed: 0.3,
		color: "70, 130, 220",
		particleOpacity: 0.8,
		lineOpacity: 0.5,
	},

	getStyles () {
		return ["MMM-PlexusBackground.css"];
	},

	start () {
		this.particles = [];
		this.canvas = null;
		this.ctx = null;
		this.animationId = null;
	},

	getDom () {
		const wrapper = document.createElement("div");
		wrapper.className = "MMM-PlexusBackground";

		this.canvas = document.createElement("canvas");
		wrapper.appendChild(this.canvas);

		this.ctx = this.canvas.getContext("2d");
		this.initCanvas();
		this.initParticles();
		this.animate();

		window.addEventListener("resize", () => this.initCanvas());

		return wrapper;
	},

	initCanvas () {
		this.canvas.width = window.innerWidth;
		this.canvas.height = window.innerHeight;
	},

	initParticles () {
		this.particles = [];
		const { particleCount, speed } = this.config;
		for (let i = 0; i < particleCount; i++) {
			this.particles.push({
				x: Math.random() * this.canvas.width,
				y: Math.random() * this.canvas.height,
				vx: (Math.random() * 2 - 1) * speed,
				vy: (Math.random() * 2 - 1) * speed,
			});
		}
	},

	animate () {
		this.update();
		this.draw();
		this.animationId = requestAnimationFrame(() => this.animate());
	},

	update () {
		const w = this.canvas.width;
		const h = this.canvas.height;
		for (const p of this.particles) {
			p.x += p.vx;
			p.y += p.vy;
			if (p.x < 0) p.x += w;
			if (p.x > w) p.x -= w;
			if (p.y < 0) p.y += h;
			if (p.y > h) p.y -= h;
		}
	},

	draw () {
		const { ctx, particles, config } = this;
		const { connectionDistance, lineThickness, lineOpacity, particleSize, particleOpacity, color } = config;

		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

		// Draw connections
		ctx.lineWidth = lineThickness;
		for (let i = 0; i < particles.length; i++) {
			for (let j = i + 1; j < particles.length; j++) {
				const dx = particles[i].x - particles[j].x;
				const dy = particles[i].y - particles[j].y;
				const dist = Math.sqrt(dx * dx + dy * dy);
				if (dist < connectionDistance) {
					const opacity = lineOpacity * (1 - dist / connectionDistance);
					ctx.strokeStyle = `rgba(${color}, ${opacity})`;
					ctx.beginPath();
					ctx.moveTo(particles[i].x, particles[i].y);
					ctx.lineTo(particles[j].x, particles[j].y);
					ctx.stroke();
				}
			}
		}

		// Draw particles
		ctx.fillStyle = `rgba(${color}, ${particleOpacity})`;
		for (const p of particles) {
			ctx.beginPath();
			ctx.arc(p.x, p.y, particleSize, 0, Math.PI * 2);
			ctx.fill();
		}
	},

	suspend () {
		cancelAnimationFrame(this.animationId);
	},

	resume () {
		this.animate();
	},
});
