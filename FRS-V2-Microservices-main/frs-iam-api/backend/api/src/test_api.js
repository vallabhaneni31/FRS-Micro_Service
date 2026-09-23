async function test() {
  for (let port of [3000, 4000, 5000]) {
    try {
      const res = await fetch(`http://localhost:${port}/api/hr/employees/1/attendance?fromDate=2026-07-01&toDate=2026-08-18`, {
        headers: { 'x-tenant-id': '5aa1dbdd-d15f-4766-bdd7-6ca864cbd065' }
      });
      const json = await res.json();
      console.log(`Port ${port}:`, JSON.stringify(json.data.slice(0, 2), null, 2));
      return;
    } catch(e) {}
  }
}
test();
