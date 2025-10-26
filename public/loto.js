document.addEventListener("DOMContentLoaded", () => {
  const bubanj = document.querySelector(".loto-bubanj");
  if (!bubanj) return;
  for (let i = 0; i < 10; i++) {
    const ball = document.createElement("div");
    ball.className = "loto-ball";
    ball.textContent = Math.floor(Math.random() * 45) + 1;
    ball.style.animationDelay = `${i * 0.3}s`;
    bubanj.appendChild(ball);
  }
});
