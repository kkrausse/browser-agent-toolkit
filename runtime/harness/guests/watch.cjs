// fs.watch (file, directory, recursive) and the ordering rule: a timer that is due runs before a watch event is delivered.
const fs = require('fs')
const path = require('path')
const dir = fs.mkdtempSync('/tmp/watch-')
fs.mkdirSync(path.join(dir, 'sub/deep'), { recursive: true })
fs.writeFileSync(path.join(dir, 'a.txt'), '1')
const seen = { dir: [], rec: [], file: [] }
const w1 = fs.watch(dir, (ev, name) => seen.dir.push(`${ev}:${name}`))
const w2 = fs.watch(dir, { recursive: true }, (ev, name) => seen.rec.push(`${ev}:${name}`))
const w3 = fs.watch(path.join(dir, 'a.txt'), (ev, name) => seen.file.push(`${ev}:${name}`))
const order = []
setTimeout(() => {
  // The first watch callback arms a 1 ms timer, causes a second watch event and then keeps the
  // thread busy until the timer is overdue. The next turn must run the timer before it delivers
  // the second event (chokidar's throttling depends on it).
  let n = 0
  w2.on('change', () => {
    order.push(`watch ${++n}`)
    if (n === 1) {
      setTimeout(() => order.push('timer'), 1)
      fs.writeFileSync(path.join(dir, 'sub/x.txt'), 'x')
      const end = Date.now() + 5
      while (Date.now() < end);
    }
  })
  fs.writeFileSync(path.join(dir, 'a.txt'), '22')
  setTimeout(() => {
    fs.writeFileSync(path.join(dir, 'sub/deep/b.txt'), 'x')
    fs.renameSync(path.join(dir, 'sub/deep/b.txt'), path.join(dir, 'sub/c.txt'))
    fs.unlinkSync(path.join(dir, 'a.txt'))
    setTimeout(() => {
      w1.close(); w2.close(); w3.close()
      console.log(JSON.stringify({ order: order.slice(0, 3), ...seen }, null, 1))
      fs.rmSync(dir, { recursive: true })
    }, 30)
  }, 20)
}, 10)
