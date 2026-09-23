async function run() {
  const adminUser = "admin";
  const adminPass = "admin";
  
  const tokenRes = await fetch("http://localhost:9090/realms/master/protocol/openid-connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: adminUser, password: adminPass })
  });
  const token = (await tokenRes.json()).access_token;
  
  const execsRes = await fetch("http://localhost:9090/admin/realms/motivity-internal/authentication/flows/browser/executions", {
    headers: { "Authorization": "Bearer " + token }
  });
  const execs = await execsRes.json();
  console.log(JSON.stringify(execs, null, 2));
}
run();
