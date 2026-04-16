function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

const results = Array.from({ length: 10 }, (_, i) => fibonacci(i));
console.log("Fibonacci sequence:", results);
console.log("Done!");
