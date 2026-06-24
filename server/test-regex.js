const regexes = [
  /\bon\w+\s*=\s*"[^"]*"/gi,
  /\bon\w+\s*=\s*'[^']*'/gi,
  /\bon\w+\s*=\s*[^\s>"']+/gi
];

const testCases = [
  '<svg onload="alert(1)">',
  '<svg/onload="alert(1)">',
  '<svg onmouseover=alert(1)>',
  '<svg width="100"onmouseover=\'alert(1)\'>',
  '<polygon points="0,0" onfoo=bar>',
  '<div class="onward">', // Should not strip
  '<div data-onward="true">', // Should not strip
  '<div nonmouseover="1">' // Should not strip
];

for (const t of testCases) {
  let res = t;
  for (const r of regexes) {
    res = res.replace(r, "");
  }
  console.log(`${t} -> ${res}`);
}
