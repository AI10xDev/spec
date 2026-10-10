import { setTimeout } from "node:timers/promises"

for (let i = 1; i <= 100; i++) {
  if (i > 1) await setTimeout(1000)
  console.log(i)
}
