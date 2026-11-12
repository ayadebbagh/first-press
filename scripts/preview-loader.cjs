const {transform,loadBindings}=require('next/dist/build/swc');
module.exports=function(source){
 const done=this.async();
 loadBindings().then(()=>transform(source,{filename:this.resourcePath,jsc:{parser:{syntax:'typescript',tsx:this.resourcePath.endsWith('.tsx')},transform:{react:{runtime:'automatic',development:false}},target:'es2022'},module:{type:'es6'},sourceMaps:false})).then(result=>done(null,result.code),done);
};
