import jwt from "jsonwebtoken";
import { pool } from "../src/db/pool.js";
import personService from "../src/services/business/PersonService.js";
import { sendEnrollmentInvitation } from "../src/services/emailService.js";

async function runTest() {
  console.log("🚀 Starting Visitor Remote Enrollment Lifecycle Test...");

  const mockScope = {
    tenantId: "88888888-8888-8888-8888-888888888888", // using a placeholder tenant
    customerId: null,
    siteId: null
  };

  await pool.query(
    `INSERT INTO frs_tenant (pk_tenant_id, tenant_name) 
     VALUES ($1, 'Test Remote Enrollment Tenant')
     ON CONFLICT (pk_tenant_id) DO NOTHING`,
    [mockScope.tenantId]
  );

  // 1. Create a visitor who wants to enroll remotely
  const visitorData = {
    fullName: "Visitor John Doe",
    email: "visitor.johndoe@example.com",
    organization: "Visitor Org",
    visitorType: "guest",
    validFrom: new Date(),
    validTo: new Date(Date.now() + 2 * 3600000)
  };

  const client = await pool.connect();
  try {
    console.log("1. Creating visitor profile...");
    const newVisitor = await personService.createVisitor({ scope: mockScope, data: visitorData });
    console.log(`✅ Visitor created: ${newVisitor.full_name} (${newVisitor.person_id})`);

    // 2. Simulate sending remote invite
    console.log("2. Generating invitation token...");
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const token = jwt.sign(
      {
        personId: newVisitor.person_id,
        tenantId: mockScope.tenantId
      },
      process.env.ENROLLMENT_TOKEN_SECRET || "default_super_secret_key_1234567890",
      { expiresIn: "7d" }
    );

    const { rows: invRows } = await pool.query(
      `INSERT INTO enrollment_invitations (
        fk_person_id,
        mt_tenant_id,
        invitation_token,
        expires_at
      ) VALUES ($1, $2::uuid, $3, $4)
      RETURNING pk_invitation_id`,
      [newVisitor.person_id, mockScope.tenantId, token, expiresAt]
    );
    const invitationId = invRows[0].pk_invitation_id;
    console.log(`✅ Invitation created with ID: ${invitationId}`);

    // 3. Verify consent recording
    console.log("3. Recording biometric consent...");
    await pool.query(
      `UPDATE person 
       SET consent_given_at = NOW(), 
           consent_method = 'web_form',
           consent_withdrawn_at = NULL
       WHERE person_id = $1`,
      [newVisitor.person_id]
    );

    await pool.query(
      `INSERT INTO biometric_consent (fk_person_id, tenant_id, consent_given, consent_method, consented_at)
       VALUES ($1, $2, true, 'web_form', NOW())`,
      [newVisitor.person_id, mockScope.tenantId]
    );
    console.log("✅ Biometric consent recorded successfully.");

    // 4. Simulate saving photos and average quality
    console.log("4. Simulating photo paths and quality scores...");
    const mockPhotoPaths = {
      front: "/uploads/remote-enrollment/mock-front.jpg",
      left: "/uploads/remote-enrollment/mock-left.jpg"
    };
    const mockQualityScores = {
      front: 0.85,
      left: 0.88
    };

    await pool.query(
      `UPDATE enrollment_invitations
       SET photo_paths = $1,
           quality_scores = $2,
           status = 'completed',
           completed_at = NOW(),
           average_quality = 0.865,
           approval_status = 'auto_approved'
       WHERE pk_invitation_id = $3`,
      [JSON.stringify(mockPhotoPaths), JSON.stringify(mockQualityScores), invitationId]
    );
    console.log("✅ Invitation marked as completed and auto_approved.");

    // 5. Creating embeddings for visitor
    console.log("5. Simulating visitor embedding insertion...");
    const mockEmbedding = Array.from({ length: 512 }, () => Math.random() * 2 - 1);
    const embeddingStr = `[${mockEmbedding.join(",")}]`;

    await pool.query(
      `INSERT INTO person_face_embeddings
       (person_id, embedding, model_version, quality_score, photo_path, created_at)
       VALUES ($1, $2::vector, 'arcface-r50-fp16', 0.865, $3, NOW())`,
      [newVisitor.person_id, embeddingStr, mockPhotoPaths.front]
    );
    console.log("✅ Face embedding saved to person_face_embeddings.");

    // 6. Verify lookup
    console.log("6. Verifying search query resolves visitor embeddings...");
    const { rows: personRes } = await pool.query(
      `SELECT 
         p.person_id, 
         p.person_type, 
         p.full_name,
         1 - (pfe.embedding <=> $1::vector) AS similarity
       FROM person_face_embeddings pfe
       JOIN person p ON p.person_id = pfe.person_id
       WHERE p.tenant_id = $2::uuid AND 1 - (pfe.embedding <=> $1::vector) >= 0.55`,
      [embeddingStr, mockScope.tenantId]
    );

    if (personRes.length > 0) {
      console.log(`✅ Success! Matched visitor: ${personRes[0].full_name} with similarity: ${personRes[0].similarity}`);
    } else {
      throw new Error("Failed to match visitor embedding using HNSW search query!");
    }

    // Clean up
    console.log("🧹 Cleaning up test records...");
    await pool.query("DELETE FROM person WHERE person_id = $1", [newVisitor.person_id]);
    await pool.query("DELETE FROM frs_tenant WHERE pk_tenant_id = $1", [mockScope.tenantId]);
    console.log("✅ Cleanup complete.");
    console.log("🎉 All integration checks passed!");

  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

runTest();
