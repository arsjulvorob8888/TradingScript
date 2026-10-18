const response = await fetch("https://carry-desk.onrender.com/api/pulse", { method: "POST" });
const text = await response.text();
console.log(response.status, text);
if (!response.ok) process.exit(1);
