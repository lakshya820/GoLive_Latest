console.log("from server side");
const express = require("express");
const speech = require("@google-cloud/speech");

require('dotenv').config();

// Imports the fs library to establish file system
const fs = require('fs');

//use logger
const logger = require("morgan");

//use body parser
const bodyParser = require("body-parser");

//use corrs
const cors = require("cors");

//use openAI
const {OpenAI} = require("openai")

const http = require("http");
const { Server } = require("socket.io");

const app = express();

app.use(cors());
app.use(logger("dev"));

app.use(bodyParser.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});

const videoFileMap={
  'cdn':'videos/cdn.mp4',
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY // This is also the default, can be omitted
});

//TODO: Create this file in the server directory of the project
process.env.GOOGLE_APPLICATION_CREDENTIALS = "./speech-to-text-key.json";

const speechClient = new speech.SpeechClient();

app.get('/videos/:filename', (req, res)=>{
  const fileName = req.params.filename;
  const filePath = videoFileMap[fileName]
  if(!filePath){
      return res.status(404).send('File not found')
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if(range){
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      const chunksize = end - start + 1;
      const file = fs.createReadStream(filePath, {start, end});
      const head = {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': 'video/mp4'
      };
      res.writeHead(206, head);
      file.pipe(res);
  }
  else{
      const head = {
          'Content-Length': fileSize,
          'Content-Type': 'video/mp4'
      };
      res.writeHead(200, head);
      fs.createReadStream(filePath).pipe(res)
  }
})

io.on("connection", (socket) => {
  let recognizeStream = null;
  console.log("** a user connected - " + socket.id + " **\n");

  socket.on("disconnect", () => {
    console.log("** user disconnected ** \n");
  });

  socket.on("send_message", (message) => {
    setTimeout(() => {
      //io.emit("receive_message", "got this message " + message);
    }, 1000);
  });

  socket.on("startGoogleCloudStream", function (data) {
    startRecognitionStream(this, data);
  });

  socket.on("endGoogleCloudStream", function () {
    console.log("** ending google cloud stream **\n");
    stopRecognitionStream();
  });
 
  let swotAnswer=null;
  socket.on('lexanswers', async (data) => {
    //console.log('Received answers from Lex:', data);
    answers=data;

    socket.on('lexquestions',async (data) => {

      let csi_score=0.0;
      socket.on("lexsentiment", (data) => {
        csi_score=sentiment_calc(data);
        console.log("**sentiment_backend:", csi_score);
        
      })
      //console.log('Received questions from Lex:', data);
      questions=data;
      if(questions !== null){

       
        relevanceresult = await relevance(answers, questions);
        //console.log("relevanceResult: ", relevanceresult);

        grammarCorrectionResult = await grammarcorrection(answers, questions);

        //console.log(grammarCorrectionResult.grammarComment, relevanceresult.comprehensionComment, relevanceresult.fluencyComment);

        swotResult = await swot(grammarCorrectionResult.grammarComment, relevanceresult.comprehensionComment, relevanceresult.fluencyComment);
        swotAnswer=swotResult;
        //console.log("grammarReceived", grammarCorrectionResult);
        io.emit("grammarCorrectionResult", grammarCorrectionResult);
        console.log("sendingswotdata: ",swotAnswer );
        io.emit("swotAnalysisResult", swotAnswer);
        io.emit("lexsentimenttofrontend", csi_score);
        //io.emit("questions", questions);

      
     
    }
    });

  });

  // if(swotAnswer){
    
  // }

  socket.on("send_audio_data", async (audioData) => {
    io.emit("receive_message", "Got audio data");
    if (recognizeStream !== null) {
      try {
        //console.log(`audio data: `, audioData.audio);
        recognizeStream.write(audioData.audio);
      } catch (err) {
        console.log("Error calling google api " + err);
      }
    } else {
      console.log("RecognizeStream is null");
    }
  });

  function startRecognitionStream(client) {
    console.log("* StartRecognitionStream\n");
    try {
      recognizeStream = speechClient
        .streamingRecognize(config)
        .on("error", console.error)
        .on("data", (data) => {
          console.log("StartRecognitionStream: data: "+data)
          const result = data.results[0];
          const isFinal = result.isFinal;

          const transcription = data.results
            .map((result) => result.alternatives[0].transcript)
            .join("\n");

          console.log(`Transcription: `, transcription);
          console.log(isFinal);

          client.emit("receive_audio_text", {
            text: transcription,
            isFinal: isFinal,
          });

          // if end of utterance, let's restart stream
          // this is a small hack to keep restarting the stream on the server and keep the connection with Google api
          // Google api disconects the stream every five minutes
          if (data.results[0] && data.results[0].isFinal) {
            stopRecognitionStream();
            startRecognitionStream(client);
          }
        });
    } catch (err) {
      console.error("Error streaming google api " + err);
    }
  }

  function stopRecognitionStream() {
    if (recognizeStream) {
      console.log("* StopRecognitionStream \n");
      recognizeStream.end();
    }
    recognizeStream = null;
  }
});

async function grammarcorrection(grammarArray, questions) {
   
  // Initialize arrays for each function call
  let correctedGrammarArray = [];
  let correct = [];
  let incorrect = [];
  let count = 0;
  let total;
  const sentences = grammarArray;
  let grammarComment = "";
 
 
 //console.log("sentences: ", sentences);
 try {
     // Iterate over each string in the grammarArray
     for (const grammar of grammarArray) {
         const completion = await openai.chat.completions.create({
             model: "gpt-4o-mini",
             messages: [
                 {
                     role: "system",
                     content: "You will be provided with statements. If a statement is already grammatically correct (e.g., 'I don't know', 'I've been eating a lot') do not change it.  Do not add any commas even if needed. Accept casual English, including abbreviations and slang. Focus on fixing major grammatical errors like verb tenses, subject-verb agreement, and sentence structure, but leave informal language as it is (e.g., 'I'm gonna', 'wanna', 'LOL')."
                 },
                 {
                     role: "user",
                     content: grammar
                 }
             ],
             temperature: 0,
             max_tokens: 60,
             top_p: 1.0,
             frequency_penalty: 0.0,
             presence_penalty: 0.0,
         });

         const grammarResult = completion.choices[0].message.content;
         //console.log("grammarresult_backend", grammarResult);

         // Push the corrected result into the array
         correctedGrammarArray.push(grammarResult);
     }

     const incorrect = grammarArray.flatMap(text =>
       text.split(/(?<=\.)\s*/).filter(sentence => sentence.trim() !== "")
     );
     //console.log("incorrect: ", incorrect);

     const correct = correctedGrammarArray.flatMap(text =>
       text.split(/(?<=\.)\s*/).filter(sentence => sentence.trim() !== "")
     );
     //console.log("correct: ", correct);

     for (let i = 0; i < sentences.length; i++) {
       if(sentences[i] !== correctedGrammarArray[i]){
         // incorrect.push(sentences[i]);
         // correct.push(correctedGrammarArray[i]);
         count++;
       }
     }
     
     //console.log("correctedgrammararray: ", correctedGrammarArray);
 } catch (error) {
     console.log("error", `Something happened! like: ${error}`);
     next(error); // If you're using this in an Express route, pass the error to the next middleware
 }

 total=(1-(count/(sentences.length)))*100;
 // console.log("counr:", count);
 // console.log("length:", grammarArray.length);
 // console.log("total:", total);
 // Return the array of corrected results

  if (total <= 25) {
    grammarComment="Grammar: Unsatisfactory";
    //console.log("Grammar: Unsatisfactory");
  } else if (total <= 50 && total > 25) {
    grammarComment="Grammar: Needs Improvement";
    //console.log("Grammar: Needs Improvement");
  } else {
    grammarComment="Grammar: Met Expectations";
    //console.log("Grammar: Met Expectations");
  }
 return {
   questions,
   grammarArray,
   correctedGrammarArray,
   total,
   grammarComment
 };
}

async function relevance(answers, questions) {

  let relevanceScoreArray=[];
  let comprehensionComment="";
  let fluencyComment="";
  let relevanceScore=0;

  for (let i = 0; i < answers.length; i++) {
    const question = questions[i];
    const answer = answers[i];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
          {
              role: "system",
              content: "Please evaluate the correctness of the following answer on a scale of 1 to 10, where 1 is completely incorrect and 10 is completely correct. Consider the relevance of the answer in relation to the question. Return only a single number with no words."
          },
          {
              role: "user",
              content: `Question: ${question} Answer: ${answer}`
          }
      ],
      temperature: 0,
      max_tokens: 60,
      top_p: 1.0,
      frequency_penalty: 0.0,
      presence_penalty: 0.0,
    });

    //console.log(`Response for question ${i + 1}:`, completion.choices[0].message.content);
    relevanceScoreArray.push(completion.choices[0].message.content);
    relevanceScore=relevanceScore + completion.choices[0].message.content;
  }

  //console.log("relevanceArrayLength", (relevanceScoreArray.length));
  if ((relevanceScore/(relevanceScoreArray.length)) <= 3) {
    comprehensionComment="Comprehension: Unsatisfactory";
    fluencyComment="Fluency/Thought process: Unsatisfactory";
    //console.log("Relevance: Unsatisfactory");
  } else if ((relevanceScore/(relevanceScoreArray.length)) <= 6 && (relevanceScore/(relevanceScoreArray.length)) > 3) {
    comprehensionComment="Comprehension: Needs Improvement";
    fluencyComment="Fluency/Thought Process: Needs Improvement";
    //console.log("Relevance: Needs Improvement");
  } else {
    comprehensionComment="Comprehension: Met expectations";
    fluencyComment="Fluency/Thought process: Met expectations";
    //console.log("Relevance: Met Expectations");
  }

  return{
    comprehensionComment,
    fluencyComment
  }
}

async function swot(grammar, comprehension, fluency){

  let swotAnalysis="";
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
        {
            role: "system",
            content: "Based on the following parameters and their values, create a SWOT analysis with separate paragraphs for Strengths, Weaknesses, Opportunities, and Threats. Do not include a main 'SWOT Analysis' header, but start directly with each section label followed by the analysis."
        },
        {
            role: "user",
            content: `${grammar}  ${comprehension} ${fluency}`
        }
    ],
    temperature: 0,
    //max_tokens: 60,
    top_p: 1.0,
    frequency_penalty: 0.0,
    presence_penalty: 0.0,
  });

  swotAnalysis=completion.choices[0].message.content;
  //console.log("swotAnalysis: ", swotAnalysis)

  return swotAnalysis
  
}

function sentiment_calc(data){
  let csi=0;
  let final_csi=0;

  // Example: Extracting Positive sentiment scores
  const positiveScores = data.map(entry => entry.Positive);
  console.log('Positive Scores:', positiveScores);

  // Example: Extracting Negative sentiment scores
  const negativeScores = data.map(entry => entry.Negative);
  console.log('Negative Scores:', negativeScores);

  // Example: Extracting Neutral sentiment scores
  const neutralScores = data.map(entry => entry.Neutral);
  console.log('Neutral Scores:', neutralScores);

  // Example: Extracting Mixed sentiment scores
  const mixedScores = data.map(entry => entry.Mixed);
  console.log('Mixed Scores:', mixedScores);

  console.log('length of array:', positiveScores.length);

  for (let i = 0; i < positiveScores.length; i++) {
   csi=csi+(positiveScores[i]-negativeScores[i]-(mixedScores[i]*0.5)-(neutralScores[i]*0.4))
   //csi=csi+(positiveScores[i]-((negativeScores[i]*-1)+(mixedScores[i]*-0.5)+(neutralScores[i]*-0.8)))
   console.log("csi: ", (positiveScores[i]-negativeScores[i]-(mixedScores[i]*0.5)));
  }

  final_csi=(csi/4)*5;
  console.log("final_csi: ", final_csi)

  return {
  final_csi
  }
}
//const port = process.env.PORT || 8081;
server.listen(8081, () => {
  console.log("WebSocket server listening on port 8081.");
});

// =========================== GOOGLE CLOUD SETTINGS ================================ //

// The encoding of the audio file, e.g. 'LINEAR16'
// The sample rate of the audio file in hertz, e.g. 16000
// The BCP-47 language code to use, e.g. 'en-US'
const encoding = "LINEAR16";
const sampleRateHertz = 16000;
const languageCode = "en-US"
const alternativeLanguageCodes = ["en-IN"];

const config = {
  config: {
    encoding: encoding,
    sampleRateHertz: sampleRateHertz,
    languageCode: languageCode,
    alternativeLanguageCodes: alternativeLanguageCodes,
    //enableWordTimeOffsets: true,  
    enableAutomaticPunctuation: true,
    //enableWordConfidence: true,
    //Speker deserilization
    //enableSpeakerDiarization: true,  
    //minSpeakerCount: 1,  
    //Silence detection
    enable_silence_detection: true,
    //no_input_timeout: 5,
    single_utterance : false, //
    interimResults: false,
    //diarizationSpeakerCount: 2,
    //model: "video",
    model: "latest_long",
    //model: "phone_call",
    //model: "command_and_search",
    useEnhanced: true,
  },
};
