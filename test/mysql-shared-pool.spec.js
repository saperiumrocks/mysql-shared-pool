const mysqlSharedPool = require('../index'); 
const _ = require('lodash');
const Bluebird = require('bluebird');

const mysqlOptions = {
    host: 'localhost',
    port: 13306,
    user: 'root',
    password: 'root',
    database: 'mysqlsharedpool',
    minPool: 1,
    maxPool: 4
};

const sleepAsync = function(sleepUntil) {
    return new Promise((resolve) => {
        setTimeout(resolve, sleepUntil);
    });
}

const mysqlServer = (function() {
    const exec = require('child_process').exec;
    const mysql = require('mysql');

    return {
        up: async function() {
            const command = `docker run --name mysqlsharedpool_mysql -e MYSQL_ROOT_PASSWORD=${mysqlOptions.password} -e MYSQL_DATABASE=${mysqlOptions.database} -p ${mysqlOptions.port}:3306 -d mysql:5.7`;
            console.log('running docker command:', command);
            const process = exec(command);

            // wait until process has exited
            console.log('downloading mysql image or creating a container. waiting for child process to return an exit code');
            do {
                await sleepAsync(1000);
            } while (process.exitCode == null);

            console.log('child process exited with exit code: ', process.exitCode);

            console.info('waiting for mysql database to start...');
            let retries = 0;
            let gaveUp = true;
            let conn = null;
            do {
                try {
                    const options = _.cloneDeep(mysqlOptions);
                    options.connectionLimit = options.maxPool;
                    options.minPool = undefined;
                    options.maxPool = undefined;

                    conn = mysql.createConnection(options);

                    Bluebird.promisifyAll(conn);

                    await conn.connectAsync();
                    console.log('connected!');
                    gaveUp = false;
                    break;
                } catch (error) {
                    conn.end();
                    console.log(`mysql retry attempt ${retries + 1} after 1000ms`);
                    await sleepAsync(1000);
                    retries++;
                }
            } while (retries < 20);

            if (gaveUp) {
                console.error('given up connecting to mysql database');
                console.error('abandoning tests');
            } else {
                console.log('successfully connected to mysql database');
            }
        },
        down: async function() {
            exec('docker rm mysqlsharedpool_mysql --force');
        }
    }
})();

describe('mysql-shared-pool tests', () => {
    beforeAll(async (done) => {
        await mysqlServer.up();
        done();
    }, 60000);

    describe('mysql-shared-pool methods', () => {
        let sharedPool;
        let options;
    
        beforeEach(async (done) => {
            options = {
                host: mysqlOptions.host,
                port: mysqlOptions.port,
                user: mysqlOptions.user,
                password: mysqlOptions.password,
                database: mysqlOptions.database,
                minPool: mysqlOptions.minPool,
                maxPool: mysqlOptions.maxPool
            };
    
            sharedPool = mysqlSharedPool.createPool(options);
            done();
        });

        describe('raw', () => {
            it('should be able to do raw sql queries', async () => {
                try {
                    await sharedPool.raw(`
                        CREATE TABLE IF NOT EXISTS users (
                            id INT AUTO_INCREMENT PRIMARY KEY,
                            name VARCHAR(255) NOT NULL,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                        );

                        INSERT INTO users (name)
                        VALUES ('Ryan');

                        INSERT INTO users (name)
                        VALUES ('Skyler');
                    `);

                    const queryResult = await sharedPool.raw('SELECT * FROM users');

                    expect(queryResult[0].name).toEqual('Ryan');
                    expect(queryResult[1].name).toEqual('Skyler');
                    
                } catch (error) {
                    console.error(error);
                }
            });
        })
    
        afterEach(async (done) => {
            done();
        })
    });
   
    // make sure for this test that no other clients are connected to the mysql server
    describe('pooling', () => {
        it('should only create the expected number of connections given multiple instances of mysqlsharedpool', async () => {
            const options = {
                connection: {
                    host: mysqlOptions.host,
                    port: mysqlOptions.port,
                    user: mysqlOptions.user,
                    password: mysqlOptions.password,
                    database: mysqlOptions.database
                },
                pool: {
                    min: mysqlOptions.minPool,
                    max: mysqlOptions.maxPool,
                    idleTimeoutMillis: 1000 // set to a few seconds so we dont have to wait a lot for the test
                }
            };
    
            const pool1 = mysqlSharedPool.createPool(options);
            const pool2 = mysqlSharedPool.createPool(options);

            // do some queries

            const queries = [];
            for (let index = 0; index < mysqlOptions.maxPool * 4; index++) {
                queries.push(pool1.raw('select * from information_schema.processlist;'));
                queries.push(pool2.raw('select * from information_schema.processlist;'));
            }

            await Promise.all(queries);

            let connectionsResult = await pool1.raw('select * from information_schema.processlist;');

            expect(connectionsResult.length).toEqual(mysqlOptions.maxPool + 1);

            // connections idle for idleTimeoutMillisPool ms are removed by the pool. and only maintains connections equal to the min pool
            await sleepAsync(9000);

            connectionsResult = await pool1.raw('select * from information_schema.processlist;');

            expect(connectionsResult.length).toEqual(mysqlOptions.minPool + 1);
        }, 10000);
    })
    afterAll(async () => {
        // NOTE: uncomment if we need to terminate the mysql every test
        // for now, it is okay since we are using a non-standard port (13306) and a fixed docker container name
        // not terminating will make the tests faster by around 11 secs
        await mysqlServer.down();
    })
});