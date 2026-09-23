import { query } from '../db/pool.js';
import process from 'process';

async function checkDuplicates() {
    try {
        console.log("Fetching all employees...");
        const empRes = await query('SELECT pk_employee_id, employee_code, full_name, email FROM hr_employee');
        const employees = empRes.rows;
        
        console.log("Fetching all face embeddings...");
        const embRes = await query('SELECT id, employee_id, embedding, photo_path FROM employee_face_embeddings');
        const embeddings = embRes.rows;

        console.log(`Found ${employees.length} employees and ${embeddings.length} embeddings.`);

        const empMap = {};
        for (const emp of employees) {
            empMap[emp.pk_employee_id] = emp;
        }

        const duplicatePairs = new Map();
        const photoPairs = new Map();

        // Ensure embeddings are parsed
        for (const e of embeddings) {
            if (typeof e.embedding === 'string') {
                try {
                    e.embedding = JSON.parse(e.embedding);
                } catch(err) {
                    e.embedding = [];
                }
            }
        }

        for (let i = 0; i < embeddings.length; i++) {
            for (let j = i + 1; j < embeddings.length; j++) {
                const emb1 = embeddings[i];
                const emb2 = embeddings[j];
                
                // Don't compare embeddings of the same employee ID
                if (emb1.employee_id === emb2.employee_id) continue;

                // Check for duplicate photos
                if (emb1.photo_path && emb2.photo_path && emb1.photo_path === emb2.photo_path) {
                    const key = [emb1.employee_id, emb2.employee_id].sort().join('-');
                    if (!photoPairs.has(key)) {
                        photoPairs.set(key, {
                            emp1: empMap[emb1.employee_id],
                            emp2: empMap[emb2.employee_id],
                            photo_path: emb1.photo_path
                        });
                    }
                }

                // Approximate match (cosine similarity)
                if (emb1.embedding && emb2.embedding && emb1.embedding.length > 0 && emb1.embedding.length === emb2.embedding.length) {
                    let dotProduct = 0;
                    let norm1 = 0;
                    let norm2 = 0;
                    for (let k = 0; k < emb1.embedding.length; k++) {
                        dotProduct += emb1.embedding[k] * emb2.embedding[k];
                        norm1 += emb1.embedding[k] * emb1.embedding[k];
                        norm2 += emb2.embedding[k] * emb2.embedding[k];
                    }
                    const sim = dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
                    if (sim > 0.65) { // updated threshold
                        const key = [emb1.employee_id, emb2.employee_id].sort().join('-');
                        if (!duplicatePairs.has(key)) {
                            duplicatePairs.set(key, {
                                emp1: empMap[emb1.employee_id],
                                emp2: empMap[emb2.employee_id],
                                similarity: sim
                            });
                        }
                    }
                }
            }
        }

        console.log("=== Duplicate Embeddings Across Different Employees ===");
        console.log(JSON.stringify(Array.from(duplicatePairs.values()), null, 2));

        console.log("=== Duplicate Photos Across Different Employees ===");
        console.log(JSON.stringify(Array.from(photoPairs.values()), null, 2));

    } catch (err) {
        console.error(err);
    }
    process.exit(0);
}

checkDuplicates();
