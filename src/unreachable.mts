export default function unreachable(): never {
  throw new Error("unreachable executed");
}
