import axios from "axios";
import { readFileSync } from "fs";
import * as path from "path";

export function add(a, b) {
  return a + b;
}

export async function fetchUser(id) {
  const file = path.join("data", "x.txt");
  const txt = readFileSync(file, "utf8");
  const res = await axios.get(`/user/${id}`);
  return { id, txt, data: res.data };
}
