async function setupKeycloak() {
    try {
        console.log("Getting admin token...");
        const tokenParams = new URLSearchParams();
        tokenParams.append('client_id', 'admin-cli');
        tokenParams.append('username', 'admin');
        tokenParams.append('password', 'admin');
        tokenParams.append('grant_type', 'password');

        const tokenRes = await fetch('http://localhost:9090/realms/master/protocol/openid-connect/token', {
            method: 'POST',
            body: tokenParams
        });
        const tokenData = await tokenRes.json();
        const token = tokenData.access_token;
        if (!token) throw new Error("Could not get admin token: " + JSON.stringify(tokenData));

        const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

        console.log("Finding client 'attendance-frontend'...");
        const clientsRes = await fetch('http://localhost:9090/admin/realms/attendance/clients?clientId=attendance-frontend', { headers });
        const clients = await clientsRes.json();
        if (!clients.length) throw new Error("Client not found");
        const clientId = clients[0].id;

        console.log("Adding Protocol Mapper to client...");
        const mapperPayload = {
            name: "tenant_id",
            protocol: "openid-connect",
            protocolMapper: "oidc-usermodel-attribute-mapper",
            consentRequired: false,
            config: {
                "user.attribute": "tenant_id",
                "claim.name": "tenant_id",
                "jsonType.label": "String",
                "id.token.claim": "true",
                "access.token.claim": "true",
                "userinfo.token.claim": "true"
            }
        };

        const addMapperRes = await fetch(`http://localhost:9090/admin/realms/attendance/clients/${clientId}/protocol-mappers/models`, {
            method: 'POST',
            headers,
            body: JSON.stringify(mapperPayload)
        });
        if (addMapperRes.status === 201 || addMapperRes.status === 409) {
            console.log("Mapper added or already exists.");
        } else {
            console.error("Failed to add mapper:", await addMapperRes.text());
        }

        console.log("Finding user 'lelouch'...");
        const usersRes = await fetch('http://localhost:9090/admin/realms/attendance/users?username=lelouch', { headers });
        const users = await usersRes.json();
        if (users.length > 0) {
            const user = users[0];
            const userId = user.id;
            console.log("Updating user attribute...");
            user.attributes = user.attributes || {};
            user.attributes.tenant_id = ["e2d95e78-91c6-4d33-9127-b3390826f50d"];

            const updateUserRes = await fetch(`http://localhost:9090/admin/realms/attendance/users/${userId}`, {
                method: 'PUT',
                headers,
                body: JSON.stringify(user)
            });
            if (updateUserRes.ok) {
                console.log("User updated successfully.");
            } else {
                console.error("Failed to update user:", await updateUserRes.text());
            }
        } else {
            console.log("User lelouch not found in Keycloak.");
        }

        console.log("Done.");
    } catch (e) {
        console.error(e);
    }
}
setupKeycloak();
