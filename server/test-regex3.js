const regexes = [
  /(?<=\s|^|['"\/])on\w+\s*=\s*"[^"]*"/gi,
  /(?<=\s|^|['"\/])on\w+\s*=\s*'[^']*'/gi,
  /(?<=\s|^|['"\/])on\w+\s*=\s*[^\s>"']+/gi
];

const testCases = [
  '<svg onload="alert(1)">',
  '<svg    onload="alert(1)">',
  '<svg/onload="alert(1)">',
  '<svg width="100"onmouseover=\'alert(1)\'>',
  '<polygon points="0,0" onfoo=bar>',
  '<div class="onward">',
  '<div data-onward="true">',
  '<div nonmouseover="1">'
];

for (const t of testCases) {
  let res = t;
  for (const r of regexes) {
    res = res.replace(r, "");
  }
  console.log(`${t} -> ${res}`);
}
