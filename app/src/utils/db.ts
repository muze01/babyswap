
export async function executeQuery(query: any, params: any = []) {
    try {
        const response = await fetch('/api/db', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                query,
                params,
            }),
        });

        if (!response.ok) {
            throw new Error('Network response was not ok');
        }

        const result =  await response.json();
        
        if (!result) {
            throw new Error('Invalid response format from database');
        }

        return result;
    } catch (error) {
        console.error('Database query error:', error);
        throw error;
    }
}